// Base de connaissances qui s'enrichit au fil des conversations.
//
// 1. Avant la réponse : on détecte le domaine (design, comptabilité…), on cherche les fiches
//    VALIDÉES qui correspondent à la question, et on les donne à l'IA comme référence.
// 2. Après la réponse (en arrière-plan) : si la personne a accepté le partage (ou si c'est
//    l'administrateur), on garde un échantillon anonymisé pour entraîner votre futur modèle,
//    et on demande à une IA d'en tirer des fiches réutilisables, qui attendent votre validation.

import type { Env } from "./config";
import type { Msg } from "./classify";
import { textOf } from "./classify";

export interface Domaine {
  id: string;
  nom: string;
  description: string;
  mots_cles: string;
}

export interface Fiche {
  id: number;
  domaine: string;
  titre: string;
  contenu: string;
  epingle: number;
}

const MAX_FICHES = 5;
const MAX_EPINGLEES = 3;
const MAX_CARACTERES_INJECTES = 6000;

// ---------------------------------------------------------------- Texte

/** Minuscules, sans accents. */
export function normaliser(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

const MOTS_VIDES = new Set(
  (
    "les des une est que qui pour dans par sur avec sans mais ou donc car pas plus tres tout tous " +
    "cette ces son ses leur leurs mon ton mes tes nos vos aux elle ils elles nous vous comment quoi " +
    "quel quelle quels quelles faire fait peux peut veux veut avoir etre suis sont ete bien aussi " +
    "the and for with this that what how you are can"
  ).split(" "),
);

/** Requête FTS5 à partir d'une question : mots significatifs, entre guillemets, reliés par OR. */
export function requeteFts(question: string): string | null {
  const mots = [...new Set((normaliser(question).match(/[\p{L}\p{N}]+/gu) ?? []).filter((m) => m.length >= 3 && !MOTS_VIDES.has(m)))];
  if (!mots.length) return null;
  return mots
    .slice(0, 12)
    .map((m) => `"${m}"`)
    .join(" OR ");
}

/** Masque les données personnelles évidentes avant stockage. */
export function anonymiser(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[courriel]")
    .replace(/\b(sk-[\w-]{10,}|gsk_\w{10,}|AIza[\w-]{20,}|admin_\w{10,})\b/g, "[clé]")
    // téléphones, comptes bancaires… : 9 chiffres ou plus (les montants et dates courts restent)
    .replace(/\+?\d[\d\s.-]{7,}\d/g, (m) => (m.replace(/\D/g, "").length >= 9 ? "[numéro]" : m));
}

// ---------------------------------------------------------------- Domaines

let cacheDomaines: { quand: number; liste: Domaine[] } | null = null;

export async function domaines(db: D1Database): Promise<Domaine[]> {
  if (cacheDomaines && Date.now() - cacheDomaines.quand < 60_000) return cacheDomaines.liste;
  const { results } = await db.prepare("SELECT id, nom, description, mots_cles FROM domaines ORDER BY nom").all<Domaine>();
  cacheDomaines = { quand: Date.now(), liste: results ?? [] };
  return cacheDomaines.liste;
}

export function viderCacheDomaines(): void {
  cacheDomaines = null;
}

/** Domaine le plus probable d'après les mots-clés trouvés dans les questions. */
export function detecterDomaine(liste: Domaine[], messages: Msg[], impose?: string | null): string {
  if (impose && liste.some((d) => d.id === impose)) return impose;
  const texte = ` ${normaliser(
    messages
      .filter((m) => m.role === "user")
      .slice(-3)
      .map((m) => textOf(m.content))
      .join(" "),
  ).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  let meilleur = "general";
  let score = 0;
  for (const d of liste) {
    const s = d.mots_cles
      .split(",")
      .map((k) => normaliser(k.trim()))
      .filter(Boolean)
      .reduce((n, k) => n + (texte.includes(` ${k} `) || texte.includes(` ${k}s `) ? 1 : 0), 0);
    if (s > score) {
      score = s;
      meilleur = d.id;
    }
  }
  return meilleur;
}

// ---------------------------------------------------------------- Recherche et injection

export async function chercherFiches(db: D1Database, domaine: string, question: string): Promise<Fiche[]> {
  const epinglees =
    (
      await db
        .prepare(
          "SELECT id, domaine, titre, contenu, epingle FROM connaissances " +
            "WHERE statut = 'valide' AND epingle = 1 AND domaine = ?1 ORDER BY maj DESC LIMIT ?2",
        )
        .bind(domaine, MAX_EPINGLEES)
        .all<Fiche>()
    ).results ?? [];

  const fts = requeteFts(question);
  const trouvees = fts
    ? ((
        await db
          .prepare(
            "SELECT c.id, c.domaine, c.titre, c.contenu, c.epingle FROM connaissances_fts f " +
              "JOIN connaissances c ON c.id = f.rowid " +
              "WHERE connaissances_fts MATCH ?1 AND c.statut = 'valide' AND c.domaine IN (?2, 'general') " +
              "ORDER BY f.rank LIMIT ?3",
          )
          .bind(fts, domaine, MAX_FICHES)
          .all<Fiche>()
      ).results ?? [])
    : [];

  const vues = new Set<number>();
  return [...epinglees, ...trouvees].filter((f) => !vues.has(f.id) && vues.add(f.id)).slice(0, MAX_FICHES + MAX_EPINGLEES);
}

/** Texte du message système qui donne les fiches à l'IA. */
export async function messageConnaissances(
  db: D1Database,
  fiches: Fiche[],
  origine: string,
): Promise<string | null> {
  if (!fiches.length) return null;
  const ids = fiches.map((f) => f.id);
  const { results: imgs } = await db
    .prepare(
      `SELECT id, connaissance, legende FROM images WHERE connaissance IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`,
    )
    .bind(...ids)
    .all<{ id: string; connaissance: number; legende: string }>();

  let texte =
    "Base de connaissances interne (fiches validées par l'administrateur). Appuie-toi dessus quand elles " +
    "sont pertinentes, sans les citer mot pour mot si ce n'est pas utile. Si une image d'exemple aide " +
    "l'utilisateur, recopie telle quelle sa ligne Markdown (celle qui suit « Image d'exemple : »).\n";
  for (const f of fiches) {
    let bloc = `\n### ${f.titre}\n${f.contenu}\n`;
    for (const im of (imgs ?? []).filter((i) => i.connaissance === f.id)) {
      bloc += `Image d'exemple : ![${im.legende.replace(/[[\]]/g, "") || f.titre}](${origine}/images/${im.id})\n`;
    }
    if (texte.length + bloc.length > MAX_CARACTERES_INJECTES) break;
    texte += bloc;
  }
  return texte;
}

/** Ajoute le message de connaissances aux messages (fusionné avec un éventuel message système). */
export function injecter(messages: Msg[], texte: string): Msg[] {
  const copie = messages.map((m) => ({ ...m }));
  if (copie[0]?.role === "system" && typeof copie[0].content === "string") {
    copie[0].content = `${copie[0].content}\n\n${texte}`;
    return copie;
  }
  return [{ role: "system", content: texte }, ...copie];
}

// ---------------------------------------------------------------- Écriture des fiches

export async function ajouterFiche(
  db: D1Database,
  f: { domaine: string; titre: string; contenu: string; statut?: string; epingle?: boolean; source?: string; modele?: string | null },
): Promise<number> {
  const maintenant = Date.now();
  const row = await db
    .prepare(
      "INSERT INTO connaissances (domaine, titre, contenu, statut, epingle, source, modele, cree, maj) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8) RETURNING id",
    )
    .bind(f.domaine, f.titre, f.contenu, f.statut ?? "attente", f.epingle ? 1 : 0, f.source ?? "manuel", f.modele ?? null, maintenant)
    .first<{ id: number }>();
  const id = row!.id;
  await db.prepare("INSERT INTO connaissances_fts (rowid, titre, contenu) VALUES (?1, ?2, ?3)").bind(id, f.titre, f.contenu).run();
  return id;
}

export async function modifierFiche(
  db: D1Database,
  id: number,
  champs: { titre?: string; contenu?: string; domaine?: string; statut?: string; epingle?: boolean },
): Promise<boolean> {
  const actuelle = await db.prepare("SELECT titre, contenu FROM connaissances WHERE id = ?1").bind(id).first<{ titre: string; contenu: string }>();
  if (!actuelle) return false;
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(champs)) {
    if (v === undefined) continue;
    vals.push(k === "epingle" ? (v ? 1 : 0) : v);
    sets.push(`${k} = ?${vals.length}`);
  }
  vals.push(Date.now());
  sets.push(`maj = ?${vals.length}`);
  vals.push(id);
  const stmts = [db.prepare(`UPDATE connaissances SET ${sets.join(", ")} WHERE id = ?${vals.length}`).bind(...vals)];
  if (champs.titre !== undefined || champs.contenu !== undefined) {
    stmts.push(
      db.prepare("DELETE FROM connaissances_fts WHERE rowid = ?1").bind(id),
      db
        .prepare("INSERT INTO connaissances_fts (rowid, titre, contenu) VALUES (?1, ?2, ?3)")
        .bind(id, champs.titre ?? actuelle.titre, champs.contenu ?? actuelle.contenu),
    );
  }
  await db.batch(stmts);
  return true;
}

export async function supprimerFiche(db: D1Database, id: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM connaissances WHERE id = ?1").bind(id),
    db.prepare("DELETE FROM connaissances_fts WHERE rowid = ?1").bind(id),
    db.prepare("DELETE FROM images WHERE connaissance = ?1").bind(id),
  ]);
}

// ---------------------------------------------------------------- Apprentissage (après la réponse)

export interface Apprentissage {
  echantillonId: string | null; // null : pas de consentement, rien n'est stocké
  domaine: string;
  messages: Msg[]; // messages de la personne, AVANT injection des fiches
  mode: string;
  extraire: boolean;
}

/** Lit le texte complet d'une réponse (flux SSE ou JSON). */
export async function lireTexte(corps: ReadableStream<Uint8Array>, contentType: string): Promise<string> {
  const brut = await new Response(corps).text();
  if (!contentType.includes("text/event-stream")) {
    try {
      return JSON.parse(brut).choices?.[0]?.message?.content ?? "";
    } catch {
      return "";
    }
  }
  let texte = "";
  for (const ligne of brut.split("\n")) {
    const l = ligne.trim();
    if (!l.startsWith("data:")) continue;
    const d = l.slice(5).trim();
    if (d === "[DONE]") break;
    try {
      texte += JSON.parse(d).choices?.[0]?.delta?.content ?? "";
    } catch {
      // morceau incomplet ignoré
    }
  }
  return texte;
}

const CONSIGNE_EXTRACTION = `Tu alimentes la base de connaissances d'un assistant, domaine : « {DOMAINE} » ({DESCRIPTION}).
À partir de l'échange ci-dessous, extrais au plus 3 fiches de connaissance RÉUTILISABLES pour d'autres personnes :
méthodes, règles, bonnes pratiques, définitions, étapes, pièges à éviter.
Règles strictes :
- rien de personnel ni de propre à cette personne (noms, montants réels, entreprises, coordonnées, code privé) ;
- rien de banal ni d'incertain ; si l'échange n'apprend rien d'utile, renvoie une liste vide ;
- en français, titre court (moins de 80 caractères), contenu clair et autonome (moins de 700 caractères).
Réponds UNIQUEMENT avec du JSON : {"fiches":[{"titre":"...","contenu":"..."}]}`;

export function lireFichesJson(texte: string): { titre: string; contenu: string }[] {
  const debut = texte.indexOf("{");
  const fin = texte.lastIndexOf("}");
  if (debut < 0 || fin <= debut) return [];
  try {
    const data = JSON.parse(texte.slice(debut, fin + 1));
    const liste = Array.isArray(data?.fiches) ? data.fiches : [];
    return liste
      .filter((f: unknown): f is { titre: string; contenu: string } => {
        const x = f as { titre?: unknown; contenu?: unknown };
        return typeof x?.titre === "string" && typeof x?.contenu === "string";
      })
      .map((f: { titre: string; contenu: string }) => ({ titre: f.titre.trim().slice(0, 120), contenu: f.contenu.trim().slice(0, 1200) }))
      .filter((f: { titre: string; contenu: string }) => f.titre.length >= 4 && f.contenu.length >= 30)
      .slice(0, 3);
  } catch {
    return [];
  }
}

/**
 * Tâche d'arrière-plan lancée après une réponse réussie.
 * `appelerIA` envoie une requête non diffusée avec les clés du serveur (fournie par index.ts).
 */
export async function apprendre(
  env: Env,
  a: Apprentissage,
  reponse: string,
  modele: string | null,
  appelerIA: (messages: Msg[]) => Promise<string | null>,
): Promise<void> {
  const db = env.DB_SAVOIR;
  if (!db || reponse.trim().length < 40) return;

  const echange = a.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: anonymiser(textOf(m.content)) }));
  const reponseAnonyme = anonymiser(reponse);

  if (a.echantillonId) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO echantillons (id, domaine, messages, reponse, modele, mode, cree) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
      )
      .bind(a.echantillonId, a.domaine, JSON.stringify(echange), reponseAnonyme, modele, a.mode, Date.now())
      .run();
  }

  if (!a.extraire) return;

  const dom = (await domaines(db)).find((d) => d.id === a.domaine);
  const derniereQuestion = [...echange].reverse().find((m) => m.role === "user")?.content ?? "";
  const sortie = await appelerIA([
    {
      role: "system",
      content: CONSIGNE_EXTRACTION.replace("{DOMAINE}", dom?.nom ?? a.domaine).replace("{DESCRIPTION}", dom?.description ?? ""),
    },
    {
      role: "user",
      content: `QUESTION :\n${derniereQuestion.slice(0, 4000)}\n\nRÉPONSE :\n${reponseAnonyme.slice(0, 6000)}`,
    },
  ]);
  if (!sortie) return;

  const statut = a.mode === "admin" && env.VALIDATION_AUTO_ADMIN === "true" ? "valide" : "attente";
  for (const f of lireFichesJson(sortie)) {
    const doublon = await db
      .prepare("SELECT id FROM connaissances WHERE domaine = ?1 AND lower(titre) = lower(?2) AND statut != 'rejete' LIMIT 1")
      .bind(a.domaine, f.titre)
      .first();
    if (doublon) continue;
    await ajouterFiche(db, { domaine: a.domaine, titre: f.titre, contenu: f.contenu, statut, source: "conversation", modele });
  }
}
