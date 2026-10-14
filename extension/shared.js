// Fonctions communes : identifiant d'installation, clés, appels à l'orchestrateur.
import { ORCHESTRATEUR_URL } from "./config.js";

/** Identifiant anonyme de cette installation (sert uniquement à compter l'essai gratuit). */
export async function ensureInstallId() {
  const { installId } = await chrome.storage.local.get("installId");
  if (installId) return installId;
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ installId: id });
  return id;
}

/** Clés de l'utilisateur : { openrouter: "sk-or-...", gemini: "...", ... } */
export async function getKeys() {
  const { keys } = await chrome.storage.local.get("keys");
  return keys ?? {};
}

export async function setKey(provider, key) {
  const keys = await getKeys();
  if (key) keys[provider] = key;
  else delete keys[provider];
  await chrome.storage.local.set({ keys });
  return keys;
}

function keysHeader(keys) {
  return Object.entries(keys)
    .filter(([, k]) => k)
    .map(([p, k]) => `${p}=${k}`)
    .join("; ");
}

async function appeler(messages, { tache, keysOverride, maxTokens, stream, signal }) {
  const installId = await ensureInstallId();
  const keys = keysOverride ?? (await getKeys());

  const headers = { "content-type": "application/json", "x-install-id": installId };
  // Clé administrateur : aucune limite (pas utilisée quand on teste une clé précise).
  const { adminKey, partage } = await chrome.storage.local.get(["adminKey", "partage"]);
  if (adminKey && !keysOverride) headers.authorization = `Bearer ${adminKey}`;
  // Consentement : conversations anonymisées utilisées pour enrichir la base et entraîner le modèle.
  if (partage === true && !keysOverride) headers["x-partage"] = "oui";
  const kh = keysHeader(keys);
  if (kh) headers["x-provider-keys"] = kh;
  if (tache) headers["x-task"] = tache;

  const body = { model: "auto", messages };
  if (maxTokens) body.max_tokens = maxTokens;
  if (stream) body.stream = true;

  const res = await fetch(`${ORCHESTRATEUR_URL}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  // Mémorise le nombre de requêtes d'essai restantes (affiché sur le bouton d'état).
  const remaining = res.headers.get("x-trial-remaining");
  if (remaining !== null && !keysOverride) {
    await chrome.storage.local.set({ trialRemaining: Number(remaining), trialDay: new Date().toISOString().slice(0, 10) });
  }

  if (!res.ok) {
    let err = {};
    try {
      err = (await res.json()).error ?? {};
    } catch {}
    const e = new Error(err.message ?? `Erreur ${res.status}`);
    e.status = res.status;
    e.action = err.action; // "connect_openrouter" quand il faut connecter un compte
    e.retryAfter = Number(res.headers.get("retry-after") ?? 0);
    throw e;
  }
  return res;
}

/** Vérifie une clé administrateur auprès de l'orchestrateur (ne consomme rien). */
export async function verifierAdmin(cle) {
  const res = await fetch(`${ORCHESTRATEUR_URL}/v1/acces`, { headers: { authorization: `Bearer ${cle}` } });
  if (!res.ok) throw new Error(`Orchestrateur injoignable (${res.status}).`);
  return (await res.json()).mode === "admin";
}

/** Réponse complète en une fois. */
export async function demanderIA(messages, options = {}) {
  const res = await appeler(messages, { ...options, stream: false });
  const data = await res.json();
  return {
    texte: data.choices?.[0]?.message?.content ?? "",
    modele: res.headers.get("x-routed-to"),
    mode: res.headers.get("x-access-mode"),
  };
}

/** Réponse en flux : `onDelta(morceau)` est appelé au fur et à mesure. */
export async function demanderIAFlux(messages, { onDelta, signal, tache } = {}) {
  const res = await appeler(messages, { tache, stream: true, signal });
  const infos = {
    modele: res.headers.get("x-routed-to"),
    echantillon: res.headers.get("x-echantillon-id"), // permet de noter la réponse 👍 / 👎
    connaissances: res.headers.get("x-connaissances"), // "domaine;nombre de fiches utilisées"
  };
  let texte = "";

  // Certains modèles ignorent "stream" et renvoient du JSON classique.
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = await res.json();
    texte = data.choices?.[0]?.message?.content ?? "";
    onDelta?.(texte);
    return { texte, ...infos };
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const ligne = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!ligne.startsWith("data:")) continue;
      const data = ligne.slice(5).trim();
      if (data === "[DONE]") return { texte, ...infos };
      try {
        const morceau = JSON.parse(data).choices?.[0]?.delta?.content;
        if (morceau) {
          texte += morceau;
          onDelta?.(morceau);
        }
      } catch {
        // ligne incomplète ou commentaire : ignorée
      }
    }
  }
  return { texte, ...infos };
}

/** Avis sur une réponse : 1 (👍), -1 (👎) ou 0 (annulé). */
export async function envoyerAvis(id, note) {
  await fetch(`${ORCHESTRATEUR_URL}/v1/avis`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, note }),
  });
}
