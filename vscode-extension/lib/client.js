// Client de l'orchestrateur (côté extension, jamais dans la vue : les clés y restent).
"use strict";

class ErreurIA extends Error {
  constructor(message, { status, action, retryAfter } = {}) {
    super(message);
    this.status = status;
    this.action = action ?? null; // "connect_openrouter" quand il faut connecter un compte
    this.retryAfter = retryAfter ?? 0;
  }
}

function keysHeader(keys) {
  return Object.entries(keys)
    .filter(([, k]) => k)
    .map(([p, k]) => `${p}=${k}`)
    .join("; ");
}

/**
 * Appelle POST /v1/chat/completions.
 * @returns {Promise<Response>}
 */
async function appeler({ url, installId, keys, adminKey, partage, messages, tache, stream, signal, maxTokens }) {
  const headers = { "content-type": "application/json", "x-install-id": installId };
  if (adminKey) headers.authorization = `Bearer ${adminKey}`; // administrateur : aucune limite
  if (partage) headers["x-partage"] = "oui"; // consentement : conversations anonymisées utilisées pour apprendre
  const kh = keysHeader(keys ?? {});
  if (kh) headers["x-provider-keys"] = kh;
  if (tache) headers["x-task"] = tache;
  const body = { model: "auto", messages };
  if (stream) body.stream = true;
  if (maxTokens) body.max_tokens = maxTokens;

  let res;
  try {
    res = await fetch(`${url.replace(/\/+$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ErreurIA(`Orchestrateur injoignable (${url}). Vérifiez le réglage « orchestrateurIA.url ».`);
  }

  if (!res.ok) {
    let err = {};
    try {
      err = (await res.json()).error ?? {};
    } catch {}
    throw new ErreurIA(err.message ?? `Erreur ${res.status}`, {
      status: res.status,
      action: err.action,
      retryAfter: Number(res.headers.get("retry-after") ?? 0),
    });
  }
  return res;
}

/** Vérifie une clé administrateur (GET /v1/acces, ne consomme rien). */
async function verifierAdmin(url, cle) {
  let res;
  try {
    res = await fetch(`${url.replace(/\/+$/, "")}/v1/acces`, { headers: { authorization: `Bearer ${cle}` } });
  } catch {
    throw new ErreurIA(`Orchestrateur injoignable (${url}).`);
  }
  if (!res.ok) throw new ErreurIA(`Erreur ${res.status}`);
  return (await res.json()).mode === "admin";
}

/** Lit une réponse (flux SSE ou JSON) et appelle onDelta pour chaque morceau. */
async function lireReponse(res, onDelta) {
  let texte = "";
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = await res.json();
    texte = data.choices?.[0]?.message?.content ?? "";
    if (texte) onDelta?.(texte);
    return texte;
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
      if (data === "[DONE]") return texte;
      try {
        const morceau = JSON.parse(data).choices?.[0]?.delta?.content;
        if (morceau) {
          texte += morceau;
          onDelta?.(morceau);
        }
      } catch {
        // ligne incomplète : ignorée
      }
    }
  }
  return texte;
}

/** Avis sur une réponse : 1 (👍), -1 (👎), 0 (annulé). */
async function envoyerAvis(url, id, note) {
  await fetch(`${url.replace(/\/+$/, "")}/v1/avis`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, note }),
  });
}

module.exports = { appeler, lireReponse, verifierAdmin, envoyerAvis, ErreurIA };
