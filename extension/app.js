// Page principale : une barre de recherche, l'historique à côté,
// et les paramètres seulement quand on clique sur le bouton d'état de la barre.
import { demanderIAFlux, ensureInstallId, envoyerAvis } from "./shared.js";
import { rendreMarkdown } from "./markdown.js";
import { infoStatut, montrerParametres } from "./settings.js";

const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES_CONTEXTE = 20;
const $ = (id) => document.getElementById(id);

let conversations = []; // [{ id, titre, messages: [{ role, content, modele?, erreur?, action? }], maj }]
let courante = null; // id de la conversation affichée
let enCours = null; // AbortController de la réponse en cours

// ---------- Stockage ----------

async function charger() {
  const { conversations: c } = await chrome.storage.local.get("conversations");
  conversations = Array.isArray(c) ? c : [];
}

async function sauver() {
  conversations.sort((a, b) => b.maj - a.maj);
  conversations = conversations.slice(0, MAX_CONVERSATIONS);
  await chrome.storage.local.set({ conversations });
}

const conv = () => conversations.find((c) => c.id === courante) ?? null;

// ---------- Historique ----------

function groupeDate(t) {
  const jour = (d) => new Date(d).toDateString();
  if (jour(t) === jour(Date.now())) return "Aujourd'hui";
  if (jour(t) === jour(Date.now() - 86_400_000)) return "Hier";
  if (Date.now() - t < 7 * 86_400_000) return "7 derniers jours";
  return "Plus ancien";
}

function rendreHistorique() {
  const filtre = $("filtre").value.trim().toLowerCase();
  const nav = $("listeConv");
  nav.textContent = "";
  const liste = conversations.filter(
    (c) =>
      !filtre ||
      c.titre.toLowerCase().includes(filtre) ||
      c.messages.some((m) => m.content.toLowerCase().includes(filtre)),
  );
  if (!liste.length) {
    const p = document.createElement("p");
    p.className = "vide-histo";
    p.textContent = filtre ? "Aucun résultat." : "Vos conversations apparaîtront ici.";
    nav.append(p);
    return;
  }
  let groupe = "";
  for (const c of liste) {
    const g = groupeDate(c.maj);
    if (g !== groupe) {
      groupe = g;
      const h = document.createElement("div");
      h.className = "groupe";
      h.textContent = g;
      nav.append(h);
    }
    const item = document.createElement("div");
    item.className = `item${c.id === courante ? " active" : ""}`;
    const ouvrir = document.createElement("button");
    ouvrir.className = "ouvrir";
    ouvrir.textContent = c.titre;
    ouvrir.title = c.titre;
    ouvrir.addEventListener("click", () => {
      courante = c.id;
      document.body.classList.remove("histo-ouvert");
      rendreTout();
    });
    const suppr = document.createElement("button");
    suppr.className = "suppr";
    suppr.textContent = "×";
    suppr.title = "Supprimer";
    suppr.setAttribute("aria-label", `Supprimer « ${c.titre} »`);
    suppr.addEventListener("click", async () => {
      conversations = conversations.filter((x) => x.id !== c.id);
      if (courante === c.id) courante = null;
      await sauver();
      rendreTout();
    });
    item.append(ouvrir, suppr);
    nav.append(item);
  }
}

// ---------- Fil de la conversation ----------

function ajouterBoutonsCode(racine) {
  for (const pre of racine.querySelectorAll("pre")) {
    const b = document.createElement("button");
    b.className = "copier";
    b.textContent = "Copier";
    b.addEventListener("click", async () => {
      await navigator.clipboard.writeText(pre.querySelector("code").textContent);
      b.textContent = "Copié";
      setTimeout(() => (b.textContent = "Copier"), 1200);
    });
    pre.append(b);
  }
}

function bulle(m) {
  const el = document.createElement("div");
  el.className = `msg ${m.role}${m.erreur ? " erreur" : ""}`;
  if (m.role === "user") {
    const t = document.createElement("div");
    t.className = "texte";
    t.textContent = m.content;
    el.append(t);
    return el;
  }
  const corps = document.createElement("div");
  corps.className = "corps";
  if (m.erreur) {
    corps.textContent = m.content;
    if (m.action === "connect_openrouter") {
      const b = document.createElement("button");
      b.className = "lien";
      b.textContent = "Se connecter avec OpenRouter";
      b.addEventListener("click", ouvrirParametres);
      corps.append(document.createElement("br"), b);
    }
  } else {
    corps.innerHTML = rendreMarkdown(m.content);
    ajouterBoutonsCode(corps);
  }
  el.append(corps);
  if (m.modele) {
    const meta = document.createElement("div");
    meta.className = "meta";
    const [domaine, n] = (m.connaissances ?? "").split(";");
    meta.textContent = `via ${m.modele}` + (Number(n) > 0 ? ` · 📚 ${n} fiche${Number(n) > 1 ? "s" : ""} (${domaine})` : "");
    if (m.echantillon) meta.append(boutonsAvis(m));
    el.append(meta);
  }
  return el;
}

/** 👍 / 👎 : aide à trier les bonnes réponses pour entraîner le modèle. */
function boutonsAvis(m) {
  const zone = document.createElement("span");
  zone.className = "avis";
  for (const [note, icone, titre] of [
    [1, "👍", "Bonne réponse"],
    [-1, "👎", "Réponse à améliorer"],
  ]) {
    const b = document.createElement("button");
    b.textContent = icone;
    b.title = titre;
    b.setAttribute("aria-label", titre);
    b.setAttribute("aria-pressed", String(m.avis === note));
    b.addEventListener("click", async () => {
      m.avis = m.avis === note ? 0 : note;
      for (const x of zone.children) x.setAttribute("aria-pressed", "false");
      if (m.avis) b.setAttribute("aria-pressed", "true");
      await sauver();
      envoyerAvis(m.echantillon, m.avis).catch(() => {});
    });
    zone.append(b);
  }
  return zone;
}

function rendreFil() {
  const c = conv();
  const vide = !c || c.messages.length === 0;
  document.body.classList.toggle("vide", vide);
  const fil = $("fil");
  fil.textContent = "";
  if (vide) return;
  for (const m of c.messages) fil.append(bulle(m));
  fil.scrollTop = fil.scrollHeight;
}

function rendreTout() {
  rendreHistorique();
  rendreFil();
  $("saisie").focus();
}

/** Messages envoyés au modèle : sans les échanges en erreur, limités aux plus récents. */
function contexte(messages) {
  const out = [];
  for (const m of messages) {
    if (m.erreur) {
      if (out.at(-1)?.role === "user") out.pop();
      continue;
    }
    if (m.content) out.push({ role: m.role, content: m.content });
  }
  return out.slice(-MAX_MESSAGES_CONTEXTE);
}

// ---------- Envoi ----------

async function envoyer(texte) {
  if (enCours || !texte.trim()) return;
  let c = conv();
  if (!c) {
    c = { id: crypto.randomUUID(), titre: texte.trim().replace(/\s+/g, " ").slice(0, 60), messages: [], maj: Date.now() };
    conversations.unshift(c);
    courante = c.id;
  }
  c.messages.push({ role: "user", content: texte.trim() });
  const aEnvoyer = contexte(c.messages);
  const reponse = { role: "assistant", content: "" };
  c.messages.push(reponse);
  c.maj = Date.now();
  rendreHistorique();
  rendreFil();

  const corps = $("fil").lastElementChild.querySelector(".corps");
  corps.classList.add("curseur");
  enCours = new AbortController();
  etatEnvoi();

  let image = 0;
  try {
    const r = await demanderIAFlux(aEnvoyer, {
      signal: enCours.signal,
      onDelta: (morceau) => {
        reponse.content += morceau;
        if (!image)
          image = requestAnimationFrame(() => {
            image = 0;
            corps.innerHTML = rendreMarkdown(reponse.content);
            const fil = $("fil");
            if (fil.scrollHeight - fil.scrollTop - fil.clientHeight < 160) fil.scrollTop = fil.scrollHeight;
          });
      },
    });
    reponse.content = r.texte || reponse.content;
    reponse.modele = r.modele;
    if (r.echantillon) reponse.echantillon = r.echantillon;
    if (r.connaissances) reponse.connaissances = r.connaissances;
  } catch (e) {
    if (e.name === "AbortError") {
      if (!reponse.content) reponse.content = "_Réponse arrêtée._";
    } else {
      reponse.content = e.message;
      reponse.erreur = true;
      reponse.action = e.action ?? null;
    }
  } finally {
    cancelAnimationFrame(image);
    enCours = null;
    c.maj = Date.now();
    await sauver();
    rendreFil();
    rendreHistorique();
    etatEnvoi();
    majStatut();
  }
}

function etatEnvoi() {
  const b = $("envoyer");
  if (enCours) {
    b.textContent = "■";
    b.setAttribute("aria-label", "Arrêter");
    b.disabled = false;
  } else {
    b.textContent = "↑";
    b.setAttribute("aria-label", "Envoyer");
    b.disabled = !$("saisie").value.trim();
  }
}

// ---------- Demande de consentement (une seule fois) ----------

async function bandeauPartage() {
  const { partage, adminKey } = await chrome.storage.local.get(["partage", "adminKey"]);
  $("bandeau").hidden = partage !== undefined || !!adminKey;
}

async function repondrePartage(oui) {
  await chrome.storage.local.set({ partage: oui });
  $("bandeau").hidden = true;
}

// ---------- Bouton d'état et paramètres ----------

async function majStatut() {
  const s = await infoStatut();
  $("pastilleTexte").textContent = s.libelle;
  $("pastille").classList.toggle("connecte", s.connecte);
}

async function ouvrirParametres() {
  $("modale").hidden = false;
  await montrerParametres($("parametres"));
  $("fermer").focus();
}

function fermerParametres() {
  $("modale").hidden = true;
  majStatut();
  $("saisie").focus();
}

// ---------- Démarrage ----------

await ensureInstallId();
await charger();

const saisie = $("saisie");
saisie.addEventListener("input", () => {
  saisie.style.height = "auto";
  saisie.style.height = `${Math.min(saisie.scrollHeight, 200)}px`;
  etatEnvoi();
});
saisie.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("barre").requestSubmit();
  }
});
$("barre").addEventListener("submit", (e) => {
  e.preventDefault();
  if (enCours) return enCours.abort();
  const texte = saisie.value;
  saisie.value = "";
  saisie.style.height = "auto";
  envoyer(texte);
});

$("nouveau").addEventListener("click", () => {
  courante = null;
  document.body.classList.remove("histo-ouvert");
  rendreTout();
});
$("filtre").addEventListener("input", rendreHistorique);
$("basculer").addEventListener("click", () => document.body.classList.toggle("histo-ouvert"));

$("pastille").addEventListener("click", ouvrirParametres);
$("partageOui").addEventListener("click", () => repondrePartage(true));
$("partageNon").addEventListener("click", () => repondrePartage(false));
$("fermer").addEventListener("click", fermerParametres);
$("modale").addEventListener("click", (e) => {
  if (e.target === $("modale")) fermerParametres();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("modale").hidden) fermerParametres();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.keys || changes.trialRemaining || changes.adminKey) majStatut();
  if (changes.partage || changes.adminKey) bandeauPartage();
});

rendreTout();
majStatut();
bandeauPartage();
if (new URLSearchParams(location.search).has("parametres")) ouvrirParametres();
