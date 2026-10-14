// API du tableau de bord administrateur (toutes les routes exigent la clé admin).
//   /admin/api/resume                        chiffres clés
//   /admin/api/domaines                      GET, POST (créer ou modifier)
//   /admin/api/domaines/:id                  DELETE (si vide)
//   /admin/api/domaines/:id/fichier.md       le « fichier » du domaine, en Markdown
//   /admin/api/connaissances                 GET (filtres), POST
//   /admin/api/connaissances/:id             PATCH, DELETE
//   /admin/api/connaissances/:id/images      POST (multipart : fichier, legende)
//   /admin/api/images/:id                    DELETE
//   /admin/api/echantillons/stats            nombre d'exemples par modèle et licence
//   /admin/api/echantillons/export           exemples au format chat (par pages)

import { statutLicence } from "./config";
import type { Env } from "./config";
import { json } from "./router";
import { ajouterFiche, modifierFiche, supprimerFiche, viderCacheDomaines } from "./savoir";

const ID_DOMAINE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const TYPES_IMAGES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const TAILLE_MAX_IMAGE = 1_500_000;
const STATUTS = ["attente", "valide", "rejete"];

const erreur = (status: number, message: string) => json(status, { error: { message } });

export async function routeAdmin(req: Request, env: Env, url: URL): Promise<Response> {
  const db = env.DB_SAVOIR;
  if (!db) return erreur(503, "Base de connaissances non configurée (liaison DB_SAVOIR manquante).");
  const p = url.pathname.replace(/^\/admin\/api/, "");
  const m = req.method;
  let r: RegExpMatchArray | null;

  // ----- Résumé
  if (m === "GET" && p === "/resume") {
    const [fiches, ech] = await db.batch([
      db.prepare("SELECT domaine, statut, COUNT(*) AS n FROM connaissances GROUP BY domaine, statut"),
      db.prepare("SELECT COUNT(*) AS n, SUM(note > 0) AS bons, SUM(note < 0) AS mauvais FROM echantillons"),
    ]);
    return json(200, { fiches: fiches.results, echantillons: ech.results?.[0] ?? { n: 0 } });
  }

  // ----- Domaines
  if (m === "GET" && p === "/domaines") {
    const { results } = await db.prepare("SELECT id, nom, description, mots_cles FROM domaines ORDER BY nom").all();
    return json(200, { domaines: results });
  }
  if (m === "POST" && p === "/domaines") {
    const b = (await req.json().catch(() => null)) as Record<string, string> | null;
    if (!b || !ID_DOMAINE.test(b.id ?? "") || !b.nom?.trim()) {
      return erreur(400, "Identifiant (minuscules, chiffres, tirets) et nom requis.");
    }
    await db
      .prepare(
        "INSERT INTO domaines (id, nom, description, mots_cles, cree) VALUES (?1, ?2, ?3, ?4, ?5) " +
          "ON CONFLICT(id) DO UPDATE SET nom = ?2, description = ?3, mots_cles = ?4",
      )
      .bind(b.id, b.nom.trim(), (b.description ?? "").trim(), (b.mots_cles ?? "").trim(), Date.now())
      .run();
    viderCacheDomaines();
    return json(200, { ok: true });
  }
  if (m === "DELETE" && (r = p.match(/^\/domaines\/([a-z0-9-]+)$/))) {
    if (r[1] === "general") return erreur(400, "Le domaine « general » ne peut pas être supprimé.");
    const n = await db.prepare("SELECT COUNT(*) AS n FROM connaissances WHERE domaine = ?1").bind(r[1]).first<{ n: number }>();
    if ((n?.n ?? 0) > 0) return erreur(409, "Ce domaine contient des fiches : déplacez-les ou supprimez-les d'abord.");
    await db.prepare("DELETE FROM domaines WHERE id = ?1").bind(r[1]).run();
    viderCacheDomaines();
    return json(200, { ok: true });
  }
  if (m === "GET" && (r = p.match(/^\/domaines\/([a-z0-9-]+)\/fichier\.md$/))) {
    return fichierDomaine(db, r[1], url.origin);
  }

  // ----- Fiches
  if (m === "GET" && p === "/connaissances") {
    const conds: string[] = [];
    const vals: unknown[] = [];
    const param = (v: unknown) => {
      vals.push(v);
      return `?${vals.length}`;
    };
    const statut = url.searchParams.get("statut");
    const domaine = url.searchParams.get("domaine");
    const q = url.searchParams.get("q");
    if (statut && STATUTS.includes(statut)) conds.push(`c.statut = ${param(statut)}`);
    if (domaine) conds.push(`c.domaine = ${param(domaine)}`);
    if (q) {
      const x = param(`%${q}%`);
      conds.push(`(c.titre LIKE ${x} OR c.contenu LIKE ${x})`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const { results } = await db
      .prepare(
        "SELECT c.id, c.domaine, c.titre, c.contenu, c.statut, c.epingle, c.source, c.modele, c.cree, c.maj FROM connaissances c " +
          `${where} ORDER BY c.maj DESC LIMIT 200`,
      )
      .bind(...vals)
      .all<{ id: number }>();
    const fiches = results ?? [];
    let images: unknown[] = [];
    if (fiches.length) {
      images =
        (
          await db
            .prepare(`SELECT id, connaissance, legende FROM images WHERE connaissance IN (${fiches.map((f) => f.id).join(",")})`)
            .all()
        ).results ?? [];
    }
    return json(200, { connaissances: fiches, images });
  }
  if (m === "POST" && p === "/connaissances") {
    const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    const titre = String(b?.titre ?? "").trim();
    const contenu = String(b?.contenu ?? "").trim();
    const domaine = String(b?.domaine ?? "general");
    if (!titre || !contenu) return erreur(400, "Titre et contenu requis.");
    if (!(await db.prepare("SELECT 1 FROM domaines WHERE id = ?1").bind(domaine).first())) return erreur(400, "Domaine inconnu.");
    const id = await ajouterFiche(db, {
      domaine,
      titre,
      contenu,
      statut: STATUTS.includes(String(b?.statut)) ? String(b?.statut) : "valide",
      epingle: !!b?.epingle,
      source: "manuel",
    });
    return json(200, { id });
  }
  if ((r = p.match(/^\/connaissances\/(\d+)$/))) {
    const id = Number(r[1]);
    if (m === "DELETE") {
      await supprimerFiche(db, id);
      return json(200, { ok: true });
    }
    if (m === "PATCH") {
      const b = ((await req.json().catch(() => null)) ?? {}) as Record<string, unknown>;
      const champs: Parameters<typeof modifierFiche>[2] = {};
      if (typeof b.titre === "string" && b.titre.trim()) champs.titre = b.titre.trim();
      if (typeof b.contenu === "string" && b.contenu.trim()) champs.contenu = b.contenu.trim();
      if (typeof b.domaine === "string") {
        if (!(await db.prepare("SELECT 1 FROM domaines WHERE id = ?1").bind(b.domaine).first())) return erreur(400, "Domaine inconnu.");
        champs.domaine = b.domaine;
      }
      if (typeof b.statut === "string" && STATUTS.includes(b.statut)) champs.statut = b.statut;
      if (typeof b.epingle === "boolean") champs.epingle = b.epingle;
      return (await modifierFiche(db, id, champs)) ? json(200, { ok: true }) : erreur(404, "Fiche introuvable.");
    }
  }

  // ----- Images
  if (m === "POST" && (r = p.match(/^\/connaissances\/(\d+)\/images$/))) {
    const id = Number(r[1]);
    if (!(await db.prepare("SELECT 1 FROM connaissances WHERE id = ?1").bind(id).first())) return erreur(404, "Fiche introuvable.");
    const form = await req.formData().catch(() => null);
    const fichier = form?.get("fichier");
    if (!fichier || typeof fichier === "string") return erreur(400, "Champ « fichier » manquant.");
    if (!TYPES_IMAGES.includes(fichier.type)) return erreur(415, "Formats acceptés : PNG, JPEG, WebP, GIF.");
    if (fichier.size > TAILLE_MAX_IMAGE) return erreur(413, "Image trop lourde (1,5 Mo maximum).");
    const imageId = crypto.randomUUID().replace(/-/g, "");
    const legende = String(form?.get("legende") ?? "").trim().slice(0, 200);
    await db
      .prepare("INSERT INTO images (id, connaissance, legende, type, donnees, taille, cree) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(imageId, id, legende, fichier.type, await fichier.arrayBuffer(), fichier.size, Date.now())
      .run();
    return json(200, { id: imageId, url: `${url.origin}/images/${imageId}` });
  }
  if (m === "DELETE" && (r = p.match(/^\/images\/([a-f0-9]{32})$/))) {
    await db.prepare("DELETE FROM images WHERE id = ?1").bind(r[1]).run();
    return json(200, { ok: true });
  }

  // ----- Données d'entraînement
  if (m === "GET" && p === "/echantillons/stats") {
    const { results } = await db
      .prepare("SELECT modele, domaine, COUNT(*) AS n, SUM(note > 0) AS bons, SUM(note < 0) AS mauvais FROM echantillons GROUP BY modele, domaine")
      .all<{ modele: string | null; domaine: string; n: number; bons: number; mauvais: number }>();
    return json(200, {
      lignes: (results ?? []).map((l) => ({ ...l, licence: statutLicence(l.modele) })),
    });
  }
  if (m === "GET" && p === "/echantillons/export") {
    return exporterEchantillons(db, env, url);
  }

  return erreur(404, "Route d'administration inconnue.");
}

/** Le « fichier » d'un domaine : toutes ses fiches validées, en Markdown, avec les images. */
async function fichierDomaine(db: D1Database, domaine: string, origine: string): Promise<Response> {
  const d = await db.prepare("SELECT id, nom, description FROM domaines WHERE id = ?1").bind(domaine).first<{ nom: string; description: string }>();
  if (!d) return erreur(404, "Domaine inconnu.");
  const [fiches, imgs] = await db.batch<{ id: number; titre: string; contenu: string; epingle: number; connaissance: number; legende: string }>([
    db.prepare("SELECT id, titre, contenu, epingle FROM connaissances WHERE domaine = ?1 AND statut = 'valide' ORDER BY epingle DESC, titre").bind(domaine),
    db.prepare("SELECT i.id, i.connaissance, i.legende FROM images i JOIN connaissances c ON c.id = i.connaissance WHERE c.domaine = ?1").bind(domaine),
  ]);
  const n = fiches.results?.length ?? 0;
  let md = `# ${d.nom}\n\n${d.description}\n\n_Fichier généré le ${new Date().toISOString().slice(0, 10)} — ${n} fiche${n > 1 ? "s" : ""} validée${n > 1 ? "s" : ""}._\n`;
  for (const f of fiches.results ?? []) {
    md += `\n## ${f.titre}${f.epingle ? " 📌" : ""}\n\n${f.contenu}\n`;
    for (const i of (imgs.results ?? []).filter((x) => x.connaissance === f.id)) {
      md += `\n![${i.legende || f.titre}](${origine}/images/${i.id})\n`;
    }
  }
  return new Response(md, {
    headers: {
      "content-type": "text/markdown; charset=utf-8",
      "content-disposition": `attachment; filename="${domaine}.md"`,
    },
  });
}

/**
 * Exemples d'entraînement au format « chat » (une conversation par ligne dans le .jsonl final).
 * Par pages de 500 (limite de temps de calcul de l'offre gratuite) : ?apres=<curseur>.
 * Filtres : domaine, noteMin (-1, 0, 1), licence=autorise|tout.
 */
async function exporterEchantillons(db: D1Database, env: Env, url: URL): Promise<Response> {
  const apres = Number(url.searchParams.get("apres") ?? 0);
  const domaine = url.searchParams.get("domaine");
  const noteMin = Number(url.searchParams.get("noteMin") ?? 0);
  const toutes = url.searchParams.get("licence") === "tout";
  const vals: unknown[] = [apres, noteMin];
  let sql = "SELECT id, domaine, messages, reponse, modele, cree FROM echantillons WHERE cree > ?1 AND note >= ?2";
  if (domaine) {
    vals.push(domaine);
    sql += " AND domaine = ?3";
  }
  sql += " ORDER BY cree LIMIT 500";
  const { results } = await db.prepare(sql).bind(...vals).all<{ messages: string; reponse: string; modele: string | null; cree: number; domaine: string }>();
  const rows = results ?? [];

  const systeme =
    env.SYSTEME_ENTRAINEMENT ??
    "Tu es un assistant congolais (RDC) serviable et précis. Tu réponds en français clair, et dans la langue de l'utilisateur quand il écrit en lingala, swahili, kikongo ou tshiluba.";
  const lignes: unknown[] = [];
  let ignores = 0;
  for (const r of rows) {
    if (!toutes && statutLicence(r.modele).statut !== "autorise") {
      ignores++;
      continue;
    }
    let messages: { role: string; content: string }[] = [];
    try {
      messages = JSON.parse(r.messages);
    } catch {
      continue;
    }
    lignes.push({ messages: [{ role: "system", content: systeme }, ...messages, { role: "assistant", content: r.reponse }] });
  }
  return json(200, {
    lignes,
    ignores,
    suivant: rows.length === 500 ? rows[rows.length - 1].cree : null,
  });
}

/** Image publique : GET /images/:id */
export async function servirImage(env: Env, id: string): Promise<Response> {
  if (!env.DB_SAVOIR || !/^[a-f0-9]{32}$/.test(id)) return new Response("Introuvable", { status: 404 });
  const im = await env.DB_SAVOIR.prepare("SELECT type, donnees FROM images WHERE id = ?1")
    .bind(id)
    .first<{ type: string; donnees: ArrayBuffer | ArrayBufferView | number[] }>();
  if (!im) return new Response("Introuvable", { status: 404 });
  const d = im.donnees;
  // Selon l'environnement, D1 renvoie un BLOB en ArrayBuffer, en vue typée ou en tableau de nombres.
  const octets: Uint8Array<ArrayBuffer> =
    d instanceof ArrayBuffer
      ? new Uint8Array(d)
      : ArrayBuffer.isView(d)
        ? new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) as ArrayBuffer)
        : new Uint8Array(d);
  return new Response(octets, {
    headers: { "content-type": im.type, "cache-control": "public, max-age=31536000, immutable" },
  });
}
