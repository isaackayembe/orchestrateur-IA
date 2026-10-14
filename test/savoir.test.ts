import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../src/index";
import type { Env } from "../src/config";
import { anonymiser, detecterDomaine, domaines, lireFichesJson, lireTexte, viderCacheDomaines } from "../src/savoir";
import { resetCooldowns } from "../src/quota";
import { resetTrialMemory } from "../src/trial";
import { d1Memoire } from "./d1-memoire";

const SCHEMA = readFileSync(new URL("../schema-savoir.sql", import.meta.url), "utf8");
const ADMIN = "admin_cle_test_0123456789";
const INSTALL = "inst-0123456789abcdef";

let env: Env;
let attente: Promise<unknown>[];
const ctx = { waitUntil: (p: Promise<unknown>) => attente.push(p) };
const fini = async () => {
  await Promise.all(attente);
  attente = [];
};

beforeEach(() => {
  resetCooldowns();
  resetTrialMemory();
  viderCacheDomaines();
  vi.unstubAllGlobals();
  attente = [];
  env = {
    GROQ_API_KEY: "srv_groq",
    ADMIN_KEYS: ADMIN,
    ALLOW_TRIAL: "true",
    ALLOW_BYOK: "true",
    DB_SAVOIR: d1Memoire(SCHEMA),
    APPRENTISSAGE: "true",
    TAUX_EXTRACTION: "1",
    VALIDATION_AUTO_ADMIN: "true",
  };
});

const req = (chemin: string, init: RequestInit & { admin?: boolean } = {}) => {
  const headers = new Headers(init.headers);
  if (init.admin) headers.set("authorization", `Bearer ${ADMIN}`);
  return new Request(`https://orch.test${chemin}`, { ...init, headers });
};
const api = async (chemin: string, init: RequestInit = {}) => {
  const r = await handle(req(`/admin/api${chemin}`, { ...init, admin: true, headers: { "content-type": "application/json", ...(init.headers ?? {}) } }), env, ctx);
  return { status: r.status, data: (await r.json()) as any };
};
const chat = (question: string, headers: Record<string, string> = {}) =>
  handle(
    req("/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: question }] }),
    }),
    env,
    ctx,
  );

/** Faux fournisseur : réponse en flux pour le chat, JSON de fiches pour l'extraction. */
function fournisseur(reponse: string, fichesJson = '{"fiches":[]}') {
  const appels: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const corps = JSON.parse(String(init.body));
      appels.push(corps);
      if (!corps.stream) {
        return new Response(JSON.stringify({ choices: [{ message: { content: fichesJson } }] }), {
          headers: { "content-type": "application/json" },
        });
      }
      const enc = new TextEncoder();
      const morceaux = reponse.match(/[\s\S]{1,7}/g) ?? [];
      return new Response(
        new ReadableStream({
          start(c) {
            for (const m of morceaux) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: m } }] })}\n\n`));
            c.enqueue(enc.encode("data: [DONE]\n\n"));
            c.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  return appels;
}

describe("détection du domaine", () => {
  it("reconnaît comptabilité, design et général", async () => {
    const liste = await domaines(env.DB_SAVOIR!);
    const d = (q: string) => detecterDomaine(liste, [{ role: "user", content: q }]);
    expect(d("Comment passer l'écriture d'amortissement au bilan selon le SYSCOHADA ?")).toBe("comptabilite");
    expect(d("Améliore la typographie et la palette de mon interface")).toBe("design-ux-ui");
    expect(d("Bonjour, comment vas-tu ?")).toBe("general");
    expect(detecterDomaine(liste, [{ role: "user", content: "bonjour" }], "comptabilite")).toBe("comptabilite");
  });
});

describe("utilisation des fiches dans les réponses", () => {
  it("injecte les fiches validées (avec image) et ignore celles en attente", async () => {
    const f1 = await api("/connaissances", {
      method: "POST",
      body: JSON.stringify({ domaine: "comptabilite", titre: "Amortissement linéaire", contenu: "Annuité = valeur d'origine / durée d'utilisation." }),
    });
    await api("/connaissances", {
      method: "POST",
      body: JSON.stringify({ domaine: "comptabilite", titre: "Amortissement dégressif secret", contenu: "Fiche non validée.", statut: "attente" }),
    });
    const form = new FormData();
    form.append("fichier", new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }), "tableau.png");
    form.append("legende", "Tableau d'amortissement");
    const up = await handle(req(`/admin/api/connaissances/${f1.data.id}/images`, { method: "POST", body: form, admin: true }), env, ctx);
    const image = (await up.json()) as { id: string; url: string };

    const appels = fournisseur("Voici la méthode.");
    const r = await chat("Comment calculer un amortissement ?", { "x-install-id": INSTALL });
    await r.text();
    expect(r.headers.get("x-connaissances")).toBe("comptabilite;1");
    const systeme = appels[0].messages[0];
    expect(systeme.role).toBe("system");
    expect(systeme.content).toContain("Amortissement linéaire");
    expect(systeme.content).toContain(`![Tableau d'amortissement](https://orch.test/images/${image.id})`);
    expect(systeme.content.includes("non validée")).toBe(false);

    const img = await handle(req(`/images/${image.id}`), env);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect([...new Uint8Array(await img.arrayBuffer())]).toEqual([137, 80, 78, 71]);
  });

  it("les fiches épinglées sont toujours fournies pour leur domaine", async () => {
    await api("/connaissances", {
      method: "POST",
      body: JSON.stringify({ domaine: "design-ux-ui", titre: "Charte graphique", contenu: "Couleur principale #C2561B, police Inter.", epingle: true }),
    });
    const appels = fournisseur("ok");
    await (await chat("Propose une maquette pour mon écran d'accueil", { "x-install-id": INSTALL })).text();
    expect(appels[0].messages[0].content).toContain("Charte graphique");
  });
});

describe("apprentissage", () => {
  it("administrateur : échantillon anonymisé + fiches extraites et validées d'office", async () => {
    const appels = fournisseur(
      "Pour un bilan SYSCOHADA, classez les comptes par classe 1 à 5. Contact : jean@exemple.cd, +243 812 345 678.",
      '{"fiches":[{"titre":"Classes de comptes au bilan","contenu":"Au bilan SYSCOHADA, les comptes des classes 1 à 5 sont regroupés en actif et passif."}]}',
    );
    const r = await chat("Comment présenter un bilan SYSCOHADA ? Mon courriel : moi@exemple.cd", { authorization: `Bearer ${ADMIN}` });
    const texteClient = await lireTexte(r.body!, r.headers.get("content-type")!);
    expect(texteClient).toContain("jean@exemple.cd"); // le client reçoit la réponse complète, non anonymisée
    const id = r.headers.get("x-echantillon-id")!;
    expect(id.length).toBe(36);
    await fini();

    expect(appels.length).toBe(2); // la réponse + l'extraction
    const ech = await env.DB_SAVOIR!.prepare("SELECT * FROM echantillons WHERE id = ?1").bind(id).first<any>();
    expect(ech.domaine).toBe("comptabilite");
    expect(ech.reponse).toContain("[courriel]");
    expect(ech.reponse).toContain("[numéro]");
    expect(ech.messages).toContain("[courriel]");
    const { data } = await api("/connaissances?domaine=comptabilite");
    expect(data.connaissances[0].titre).toBe("Classes de comptes au bilan");
    expect(data.connaissances[0].statut).toBe("valide");
    expect(data.connaissances[0].source).toBe("conversation");
  });

  it("utilisateur qui a accepté : fiches mises en attente de validation", async () => {
    fournisseur(
      "Pour une interface lisible, limitez-vous à deux polices et gardez un contraste suffisant entre texte et fond.",
      '{"fiches":[{"titre":"Deux polices maximum","contenu":"Une interface lisible utilise au plus deux polices : une pour les titres, une pour le texte."}]}',
    );
    const r = await chat("Quelle typographie pour mon interface ?", { "x-install-id": INSTALL, "x-partage": "oui" });
    await r.text();
    await fini();
    const { data } = await api("/connaissances?statut=attente");
    expect(data.connaissances.length).toBe(1);
    expect(data.connaissances[0].domaine).toBe("design-ux-ui");
  });

  it("sans consentement : rien n'est stocké ni analysé", async () => {
    const appels = fournisseur("Une longue réponse qui ne doit pas être conservée par le serveur, faute de consentement.");
    const r = await chat("Quelle typographie pour mon interface ?", { "x-install-id": INSTALL });
    await r.text();
    await fini();
    expect(r.headers.get("x-echantillon-id")).toBe(null);
    expect(appels.length).toBe(1);
    const n = await env.DB_SAVOIR!.prepare("SELECT COUNT(*) AS n FROM echantillons").first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("une fiche déjà connue n'est pas recréée", async () => {
    const json = '{"fiches":[{"titre":"Deux polices maximum","contenu":"Une interface lisible utilise au plus deux polices."}]}';
    for (let i = 0; i < 2; i++) {
      fournisseur("Réponse suffisamment longue pour déclencher l'analyse de la conversation.", json);
      await (await chat("Typographie de mon interface ?", { authorization: `Bearer ${ADMIN}` })).text();
      await fini();
    }
    const { data } = await api("/connaissances");
    expect(data.connaissances.length).toBe(1);
  });
});

describe("tableau de bord", () => {
  it("refuse l'accès sans clé administrateur", async () => {
    const r = await handle(req("/admin/api/resume"), env);
    expect(r.status).toBe(401);
  });

  it("domaines, modification, fichier .md, suppression", async () => {
    expect((await api("/domaines", { method: "POST", body: JSON.stringify({ id: "Mauvais ID", nom: "x" }) })).status).toBe(400);
    await api("/domaines", { method: "POST", body: JSON.stringify({ id: "agriculture", nom: "Agriculture", mots_cles: "manioc,culture,recolte" }) });
    const { data } = await api("/connaissances", {
      method: "POST",
      body: JSON.stringify({ domaine: "agriculture", titre: "Bouturage du manioc", contenu: "Utiliser des boutures de 20 à 25 cm." }),
    });
    expect((await api(`/connaissances/${data.id}`, { method: "PATCH", body: JSON.stringify({ contenu: "Boutures saines de 20 à 25 cm, plantées inclinées." }) })).status).toBe(200);

    // La recherche plein texte suit la modification
    const appels = fournisseur("ok");
    await (await chat("Comment planter des boutures de manioc ?", { "x-install-id": INSTALL })).text();
    expect(appels[0].messages[0].content).toContain("plantées inclinées");

    const md = await handle(req("/admin/api/domaines/agriculture/fichier.md", { admin: true }), env);
    const texte = await md.text();
    expect(texte).toContain("# Agriculture");
    expect(texte).toContain("## Bouturage du manioc");

    expect((await api("/domaines/agriculture", { method: "DELETE" })).status).toBe(409);
    await api(`/connaissances/${data.id}`, { method: "DELETE" });
    expect((await api("/domaines/agriculture", { method: "DELETE" })).status).toBe(200);
  });

  it("export d'entraînement : filtre par licence et par avis", async () => {
    const ajouter = (id: string, modele: string, note: number) =>
      env.DB_SAVOIR!.prepare(
        "INSERT INTO echantillons (id, domaine, messages, reponse, modele, mode, note, cree) VALUES (?1, 'general', ?2, 'Réponse', ?3, 'admin', ?4, ?5)",
      )
        .bind(id, JSON.stringify([{ role: "user", content: "Question" }]), modele, note, Date.now() + Number(id))
        .run();
    await ajouter("1", "groq/llama-3.3-70b-versatile", 0);
    await ajouter("2", "gemini/gemini-flash-latest", 0);
    await ajouter("3", "openrouter/qwen/qwen3-coder:free", 1);

    const auto = (await api("/echantillons/export")).data;
    expect(auto.lignes.length).toBe(2);
    expect(auto.ignores).toBe(1);
    expect(auto.lignes[0].messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant"]);
    expect((await api("/echantillons/export?licence=tout")).data.lignes.length).toBe(3);

    // Avis 👎 sur l'échantillon 1 : exclu avec noteMin=0
    await handle(req("/v1/avis", { method: "POST", body: JSON.stringify({ id: "1", note: -1 }) }), env);
    expect((await api("/echantillons/export?noteMin=0")).data.lignes.length).toBe(1);

    const stats = (await api("/echantillons/stats")).data.lignes;
    expect(stats.find((l: any) => l.modele.startsWith("gemini")).licence.statut).toBe("interdit");
  });
});

describe("outils", () => {
  it("anonymise courriels, numéros et clés, garde les petits montants", () => {
    const s = anonymiser("Écrivez à a.b@site.cd ou au +243 99 123 45 67. Clé sk-or-v1-abcdef123456. Total : 1 250 USD le 2026-10-14.");
    expect(s).toBe("Écrivez à [courriel] ou au [numéro]. Clé [clé]. Total : 1 250 USD le 2026-10-14.");
  });

  it("lit les fiches JSON même entourées de texte, et filtre les fiches vides", () => {
    expect(lireFichesJson('Voici : {"fiches":[{"titre":"Règle utile","contenu":"Un contenu suffisamment long pour être gardé."},{"titre":"x","contenu":"court"}]} fin')).toEqual([
      { titre: "Règle utile", contenu: "Un contenu suffisamment long pour être gardé." },
    ]);
    expect(lireFichesJson("pas de json")).toEqual([]);
  });
});
