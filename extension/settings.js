// Paramètres : connexion OpenRouter en 1 clic et clés facultatives.
// Affichés dans une fenêtre, seulement quand on clique sur le bouton d'état de la barre.
import { FOURNISSEURS, ORCHESTRATEUR_URL } from "./config.js";
// Note : la clé administrateur est stockée sous "adminKey" dans chrome.storage.local.
import { demanderIA, getKeys, setKey, verifierAdmin } from "./shared.js";

/** Texte du bouton d'état sur la barre de recherche. */
export async function infoStatut() {
  const { adminKey } = await chrome.storage.local.get("adminKey");
  if (adminKey) return { connecte: true, admin: true, libelle: "Admin" };
  const keys = await getKeys();
  const { trialRemaining, trialDay } = await chrome.storage.local.get(["trialRemaining", "trialDay"]);
  if (Object.keys(keys).length > 0) return { connecte: true, libelle: "Connecté" };
  const aujourdhui = new Date().toISOString().slice(0, 10);
  const reste = trialDay === aujourdhui && Number.isFinite(trialRemaining) ? ` · ${trialRemaining}` : "";
  return { connecte: false, libelle: `Essai${reste}` };
}

/** Construit le contenu des paramètres dans `racine`. */
export async function montrerParametres(racine) {
  racine.innerHTML = `
    <h2 class="p-titre">Paramètres</h2>
    <div class="p-statut"><span id="pBadge" class="badge"></span><p id="pStatutTexte"></p></div>

    <section class="p-carte">
      <h3 id="orTitre"></h3>
      <p id="orTexte"></p>
      <div class="p-ligne">
        <button id="btnConnecter" class="p-principal">Se connecter avec OpenRouter</button>
        <button id="btnDeconnecter" hidden>Déconnecter</button>
      </div>
      <p id="orMsg" class="p-msg"></p>
    </section>

    <section class="p-carte">
      <h3>Aider à améliorer l'assistant</h3>
      <p>Vos conversations, une fois anonymisées (courriels, numéros et clés masqués), servent à enrichir la base de
        connaissances et à entraîner notre propre modèle. Vous pouvez changer d'avis à tout moment.</p>
      <label class="p-case"><input id="partage" type="checkbox"> J'accepte le partage anonymisé de mes conversations</label>
    </section>

    <details class="p-carte">
      <summary>Plus de capacité (facultatif)</summary>
      <p>Ajoutez vos propres clés gratuites : l'orchestrateur basculera entre elles quand l'une atteint sa limite.
        Chaque clé se crée en 1 à 2 minutes.</p>
      <div id="listeFournisseurs"></div>
    </details>

    <details class="p-carte" id="blocAdmin">
      <summary>Accès administrateur</summary>
      <p>Réservé au propriétaire de l'orchestrateur : aucune limite, clés du serveur + vos clés.</p>
      <div class="p-ligne">
        <input id="cleAdmin" type="password" autocomplete="off" spellcheck="false" placeholder="Clé administrateur">
        <button id="btnAdmin">Vérifier et enregistrer</button>
        <button id="btnAdminRetirer">Retirer</button>
      </div>
      <p id="adminMsg" class="p-msg"></p>
      <p id="lienTableau" hidden><a target="_blank" rel="noopener">Ouvrir le tableau de bord de la base de connaissances →</a></p>
    </details>

    <p class="p-note">Vos clés restent dans ce navigateur. Elles sont envoyées à l'orchestrateur à chaque requête,
      qui ne les enregistre pas.</p>`;

  const $ = (sel) => racine.querySelector(sel);

  const message = (el, texte, type = "") => {
    el.textContent = texte;
    el.className = `p-msg ${type}`;
  };

  async function rafraichir() {
    const keys = await getKeys();
    const statut = await infoStatut();
    const connecteOR = !!keys.openrouter;
    $("#pBadge").textContent = statut.admin ? "Admin" : statut.connecte ? "Connecté" : "Essai";
    $("#pBadge").className = `badge ${statut.connecte ? "ok" : ""}`;
    $("#pStatutTexte").textContent = statut.admin
      ? "Accès administrateur : aucune limite d'essai."
      : statut.connecte
        ? `Vous utilisez vos propres clés : ${Object.keys(keys).map((p) => FOURNISSEURS[p]?.nom ?? p).join(", ")}.`
        : `Mode essai, limité par jour${statut.libelle.includes("·") ? ` (reste ${statut.libelle.split("· ")[1]} aujourd'hui)` : ""}.`;
    $("#btnAdminRetirer").hidden = !statut.admin;
    $("#lienTableau").hidden = !statut.admin;
    $("#lienTableau a").href = `${ORCHESTRATEUR_URL}/admin/`;
    const { partage } = await chrome.storage.local.get("partage");
    $("#partage").checked = partage === true;
    if (statut.admin) $("#blocAdmin").open = true;
    $("#btnConnecter").hidden = connecteOR;
    $("#btnDeconnecter").hidden = !connecteOR;
    $("#orTitre").textContent = connecteOR ? "OpenRouter est connecté" : "Continuer sans limite d'essai";
    $("#orTexte").textContent = connecteOR
      ? "Vos requêtes utilisent votre propre quota gratuit OpenRouter, avec bascule entre plusieurs modèles."
      : "Gratuit, environ 30 secondes : vous vous connectez chez OpenRouter (par exemple avec Google) et la clé arrive automatiquement. Rien à copier.";
    for (const p of Object.keys(FOURNISSEURS)) {
      const input = racine.querySelector(`#cle-${p}`);
      if (input && document.activeElement !== input) input.value = keys[p] ?? "";
    }
  }

  // Connexion OpenRouter en 1 clic (OAuth PKCE)
  $("#btnConnecter").addEventListener("click", async (ev) => {
    ev.target.disabled = true;
    message($("#orMsg"), "Ouverture de la fenêtre de connexion OpenRouter…");
    try {
      const key = await connexionOpenRouter();
      await setKey("openrouter", key);
      message($("#orMsg"), "Connecté !", "ok");
    } catch (e) {
      const annule = /did not approve|canceled|cancelled|closed/i.test(String(e?.message));
      message(
        $("#orMsg"),
        annule ? "Connexion annulée." : `${e.message} Vous pouvez aussi coller une clé OpenRouter dans « Plus de capacité ».`,
        "err",
      );
    } finally {
      ev.target.disabled = false;
      await rafraichir();
    }
  });

  $("#btnDeconnecter").addEventListener("click", async () => {
    await setKey("openrouter", null);
    message($("#orMsg"), "OpenRouter déconnecté.");
    await rafraichir();
  });

  // Consentement au partage
  $("#partage").addEventListener("change", async (ev) => {
    await chrome.storage.local.set({ partage: ev.target.checked });
  });

  // Accès administrateur
  $("#btnAdmin").addEventListener("click", async (ev) => {
    const cle = $("#cleAdmin").value.trim();
    if (!cle) return message($("#adminMsg"), "Collez d'abord la clé.", "err");
    ev.target.disabled = true;
    try {
      if (!(await verifierAdmin(cle))) throw new Error("Clé refusée par l'orchestrateur.");
      await chrome.storage.local.set({ adminKey: cle });
      $("#cleAdmin").value = "";
      message($("#adminMsg"), "Accès administrateur activé.", "ok");
    } catch (e) {
      message($("#adminMsg"), e.message, "err");
    } finally {
      ev.target.disabled = false;
      await rafraichir();
    }
  });
  $("#btnAdminRetirer").addEventListener("click", async () => {
    await chrome.storage.local.remove("adminKey");
    message($("#adminMsg"), "Accès administrateur retiré.");
    await rafraichir();
  });

  // Clés facultatives
  const liste = $("#listeFournisseurs");
  for (const [p, f] of Object.entries(FOURNISSEURS)) {
    const bloc = document.createElement("div");
    bloc.className = "p-fournisseur";
    bloc.innerHTML = `
      <div class="p-ligne p-entete"><strong></strong><a target="_blank" rel="noopener">Obtenir une clé gratuite →</a></div>
      <div class="p-ligne">
        <input type="password" autocomplete="off" spellcheck="false" placeholder="Collez votre clé ici">
        <button data-action="tester">Tester et enregistrer</button>
        <button data-action="supprimer">Supprimer</button>
      </div>
      <p class="p-msg"></p>`;
    bloc.querySelector("strong").textContent = p === "openrouter" ? `${f.nom} (clé manuelle)` : f.nom;
    bloc.querySelector("a").href = f.console;
    const input = bloc.querySelector("input");
    input.id = `cle-${p}`;
    const msg = bloc.querySelector(".p-msg");

    bloc.querySelector('[data-action="tester"]').addEventListener("click", async (ev) => {
      const cle = input.value.trim();
      if (!cle) return message(msg, "Collez d'abord une clé.", "err");
      ev.target.disabled = true;
      message(msg, "Test en cours…");
      try {
        const r = await demanderIA([{ role: "user", content: "Réponds seulement : OK" }], {
          keysOverride: { [p]: cle },
          maxTokens: 5,
        });
        await setKey(p, cle);
        message(msg, `Clé valide (modèle : ${r.modele}). Enregistrée.`, "ok");
      } catch (e) {
        message(msg, `Clé non validée : ${e.message}`, "err");
      } finally {
        ev.target.disabled = false;
        await rafraichir();
      }
    });

    bloc.querySelector('[data-action="supprimer"]').addEventListener("click", async () => {
      await setKey(p, null);
      input.value = "";
      message(msg, "Clé supprimée.");
      await rafraichir();
    });

    liste.appendChild(bloc);
  }

  await rafraichir();
}

// ---------- OAuth PKCE OpenRouter ----------

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function connexionOpenRouter() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
  );
  const state = crypto.randomUUID();
  const redirect = chrome.identity.getRedirectURL("openrouter"); // https://<id-extension>.chromiumapp.org/openrouter
  const authUrl =
    "https://openrouter.ai/auth" +
    `?callback_url=${encodeURIComponent(redirect)}` +
    `&code_challenge=${challenge}&code_challenge_method=S256&state=${state}`;

  const retour = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  const params = new URL(retour).searchParams;
  if (params.get("state") !== state) throw new Error("Réponse de connexion inattendue. Réessayez.");
  const code = params.get("code");
  if (!code) throw new Error("Connexion annulée.");

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
