// Connexion OpenRouter en 1 clic pour VS Code (OAuth PKCE).
// OpenRouter accepte les adresses de retour localhost sur n'importe quel port :
// on ouvre un petit serveur local le temps de la connexion.
"use strict";

const http = require("http");
const crypto = require("crypto");

const b64url = (buf) => buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const PAGE_OK = `<!doctype html><meta charset="utf-8"><title>Connecté</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0;background:#F4F3EE;color:#12161F">
<div style="text-align:center"><h1 style="margin:0 0 8px">Connecté à OpenRouter</h1>
<p>Vous pouvez fermer cet onglet et revenir dans votre éditeur.</p></div></body>`;

const PAGE_ERREUR = (m) => `<!doctype html><meta charset="utf-8"><title>Erreur</title>
<body style="font-family:system-ui;padding:40px"><h1>Connexion impossible</h1><p>${m}</p></body>`;

/**
 * @param {(url: string) => Promise<void>} ouvrirNavigateur  ouvre l'URL dans le navigateur
 * @param {(local: string) => Promise<string>} adresseExterne  adapte localhost (ex. Codespaces)
 * @param {{ annulation?: { onCancellationRequested(f: () => void): void } }} [options]
 * @returns {Promise<string>} la clé OpenRouter de l'utilisateur
 */
async function connecterOpenRouter(ouvrirNavigateur, adresseExterne, options = {}) {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  const state = crypto.randomUUID();

  const serveur = http.createServer();
  await new Promise((ok, ko) => serveur.listen(0, ok).once("error", ko));
  const port = serveur.address().port;
  const retourLocal = `http://localhost:${port}/callback`;
  const retour = await adresseExterne(retourLocal);

  const code = await new Promise((resolve, reject) => {
    const minuterie = setTimeout(() => reject(new Error("Délai dépassé : connexion non terminée.")), 5 * 60_000);
    options.annulation?.onCancellationRequested(() => reject(new Error("Connexion annulée.")));
    serveur.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", retourLocal);
      if (u.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const c = u.searchParams.get("code");
      if (u.searchParams.get("state") !== state || !c) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" }).end(PAGE_ERREUR("Réponse inattendue."));
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE_OK);
      clearTimeout(minuterie);
      resolve(c);
    });

    const auth =
      "https://openrouter.ai/auth" +
      `?callback_url=${encodeURIComponent(retour)}` +
      `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;
    ouvrirNavigateur(auth).catch(reject);
  }).finally(() => serveur.close());

  const res = await fetch("https://openrouter.ai/api/v1/auth/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: "S256" }),
  });
  if (!res.ok) throw new Error(`OpenRouter a refusé l'échange (${res.status}).`);
  const { key } = await res.json();
  if (!key) throw new Error("OpenRouter n'a pas renvoyé de clé.");
  return key;
}

module.exports = { connecterOpenRouter };
