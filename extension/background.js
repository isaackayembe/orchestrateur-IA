// Service worker : ouvre la page principale et répond aux autres scripts de l'extension.
//
// Depuis un content script ou une popup :
//   const r = await chrome.runtime.sendMessage({ type: "ia", messages: [{ role: "user", content: "Bonjour" }] });
//   if (r.ok) afficher(r.texte);
//   else if (r.action === "connect_openrouter") chrome.runtime.sendMessage({ type: "ouvrirParametres" });

import { demanderIA, ensureInstallId } from "./shared.js";

/** Ouvre (ou ramène au premier plan) la page principale. */
async function ouvrirPage(parametres = false) {
  const url = chrome.runtime.getURL("index.html");
  // getContexts trouve nos propres onglets sans demander la permission "tabs".
  const contextes = chrome.runtime.getContexts
    ? await chrome.runtime.getContexts({ contextTypes: ["TAB"] }).catch(() => [])
    : [];
  const onglet = contextes.find((c) => c.documentUrl?.startsWith(url));
  if (onglet && !parametres) {
    await chrome.tabs.update(onglet.tabId, { active: true });
    await chrome.windows.update(onglet.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: parametres ? `${url}?parametres=1` : url });
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  await ensureInstallId();
  if (reason === "install") ouvrirPage(); // l'essai marche tout de suite
});

// Clic sur l'icône de l'extension
chrome.action.onClicked.addListener(() => ouvrirPage());

chrome.runtime.onMessage.addListener((msg, _sender, repondre) => {
  if (msg?.type === "ouvrirParametres") {
    ouvrirPage(true);
    return;
  }
  if (msg?.type !== "ia") return;

  demanderIA(msg.messages, { tache: msg.tache })
    .then((r) => repondre({ ok: true, ...r }))
    .catch((e) =>
      repondre({ ok: false, erreur: e.message, action: e.action ?? null, reessayerDans: e.retryAfter || null }),
    );
  return true; // réponse asynchrone
});
