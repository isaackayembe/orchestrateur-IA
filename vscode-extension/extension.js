// Assistant IA pour VS Code (et Cursor, VSCodium, Windsurf…).
// Les appels à l'orchestrateur et les clés restent côté extension ; la vue n'affiche que le chat.
"use strict";

const vscode = require("vscode");
const crypto = require("crypto");
const { appeler, lireReponse, verifierAdmin, envoyerAvis } = require("./lib/client");
const { connecterOpenRouter } = require("./lib/openrouter");

const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES_CONTEXTE = 20;
const CLE_SECRETS = "orchestrateurIA.cles";
const CLE_ADMIN = "orchestrateurIA.admin";

const FOURNISSEURS = {
  gemini: { nom: "Google Gemini", console: "https://aistudio.google.com/apikey" },
  groq: { nom: "Groq", console: "https://console.groq.com/keys" },
  mistral: { nom: "Mistral", console: "https://console.mistral.ai/api-keys" },
  openrouter: { nom: "OpenRouter", console: "https://openrouter.ai/keys" },
};

// ---------------------------------------------------------------- Données

class Donnees {
  /** @param {vscode.ExtensionContext} ctx */
  constructor(ctx) {
    this.ctx = ctx;
  }
  get url() {
    return vscode.workspace.getConfiguration("orchestrateurIA").get("url", "");
  }
  get partage() {
    return vscode.workspace.getConfiguration("orchestrateurIA").get("partagerConversations", false);
  }
  get origine() {
    try {
      return new URL(this.url).origin;
    } catch {
      return "";
    }
  }
  get contexteMax() {
    return vscode.workspace.getConfiguration("orchestrateurIA").get("contexteMaxCaracteres", 20000);
  }
  async installId() {
    let id = this.ctx.globalState.get("installId");
    if (!id) {
      id = crypto.randomUUID();
      await this.ctx.globalState.update("installId", id);
    }
    return id;
  }
  async cles() {
    try {
      return JSON.parse((await this.ctx.secrets.get(CLE_SECRETS)) ?? "{}");
    } catch {
      return {};
    }
  }
  async definirCle(fournisseur, cle) {
    const c = await this.cles();
    if (cle) c[fournisseur] = cle;
    else delete c[fournisseur];
    await this.ctx.secrets.store(CLE_SECRETS, JSON.stringify(c));
  }
  async effacerCles() {
    await this.ctx.secrets.delete(CLE_SECRETS);
  }
  async cleAdmin() {
    return (await this.ctx.secrets.get(CLE_ADMIN)) || null;
  }
  async definirCleAdmin(cle) {
    if (cle) await this.ctx.secrets.store(CLE_ADMIN, cle);
    else await this.ctx.secrets.delete(CLE_ADMIN);
  }
  conversations() {
    return this.ctx.globalState.get("conversations", []);
  }
  async sauverConversations(liste) {
    liste.sort((a, b) => b.maj - a.maj);
    await this.ctx.globalState.update("conversations", liste.slice(0, MAX_CONVERSATIONS));
  }
  async statut() {
    if (await this.cleAdmin()) return { connecte: true, admin: true, libelle: "Admin" };
    const cles = await this.cles();
    if (Object.keys(cles).length) return { connecte: true, libelle: "Connecté" };
    const { reste, jour } = this.ctx.globalState.get("essai", {});
    const aujourdhui = new Date().toISOString().slice(0, 10);
    return { connecte: false, libelle: jour === aujourdhui && Number.isFinite(reste) ? `Essai · ${reste}` : "Essai" };
  }
  async noterEssai(reste) {
    await this.ctx.globalState.update("essai", { reste, jour: new Date().toISOString().slice(0, 10) });
  }
}

// ---------------------------------------------------------------- Contexte de l'éditeur

let dernierEditeur = vscode.window.activeTextEditor;

/** Sélection (ou fichier entier) de l'éditeur actif, tronquée. */
function contexteEditeur(max, { selectionSeulement = false } = {}) {
  const ed = vscode.window.activeTextEditor ?? dernierEditeur;
  if (!ed) return null;
  const sel = ed.selection;
  const aSelection = sel && !sel.isEmpty;
  if (selectionSeulement && !aSelection) return null;
  let texte = aSelection ? ed.document.getText(sel) : ed.document.getText();
  const tronque = texte.length > max;
  if (tronque) texte = texte.slice(0, max);
  return {
    fichier: vscode.workspace.asRelativePath(ed.document.uri),
    langue: ed.document.languageId,
    portee: aSelection ? `lignes ${sel.start.line + 1}–${sel.end.line + 1}` : "fichier entier",
    extrait: texte,
    tronque,
  };
}

function contenuPourModele(m) {
  if (!m.contexte) return m.content;
  const c = m.contexte;
  return (
    `${m.content}\n\nContexte — ${c.fichier} (${c.portee}${c.tronque ? ", tronqué" : ""}) :\n` +
    "```" + c.langue + "\n" + c.extrait + "\n```"
  );
}

function messagesPourModele(messages) {
  const out = [];
  for (const m of messages) {
    if (m.erreur) {
      if (out.at(-1)?.role === "user") out.pop();
      continue;
    }
    if (m.content) out.push({ role: m.role, content: contenuPourModele(m) });
  }
  return out.slice(-MAX_MESSAGES_CONTEXTE);
}

// ---------------------------------------------------------------- Vue du chat

class VueChat {
  /** @param {vscode.ExtensionContext} ctx @param {Donnees} donnees */
  constructor(ctx, donnees) {
    this.ctx = ctx;
    this.donnees = donnees;
    this.vue = null;
    this.courante = null; // id de conversation
    this.enCours = null; // AbortController
    this.enAttente = null; // question reçue avant que la vue soit prête
    this.prete = false;
  }

  /** @param {vscode.WebviewView} vue */
  resolveWebviewView(vue) {
    this.vue = vue;
    this.prete = false;
    const media = vscode.Uri.joinPath(this.ctx.extensionUri, "media");
    vue.webview.options = { enableScripts: true, localResourceRoots: [media] };
    vue.webview.html = this.html(vue.webview, media);
    vue.webview.onDidReceiveMessage((m) => this.recevoir(m));
    vue.onDidChangeVisibility(() => vue.visible && this.pousserEtat());
  }

  html(webview, media) {
    const nonce = crypto.randomBytes(16).toString("hex");
    const uri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(media, f));
    return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: ${this.donnees.origine};">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${uri("chat.css")}"></head>
<body class="vide">
  <header class="haut">
    <button id="btnHisto" class="icone" title="Historique" aria-label="Historique">☰</button>
    <span id="titre" class="titre">Nouvelle conversation</span>
    <button id="btnNouveau" class="icone" title="Nouvelle conversation" aria-label="Nouvelle conversation">＋</button>
  </header>
  <aside id="histo" class="histo" hidden>
    <input id="filtre" type="search" placeholder="Rechercher dans l'historique">
    <nav id="liste"></nav>
  </aside>
  <section id="fil" class="fil"></section>
  <div class="accueil">
    <h1>Que voulez-vous savoir ?</h1>
    <p>Posez une question, ou sélectionnez du code puis :</p>
    <div class="raccourcis">
      <button data-cmd="expliquer">Expliquer la sélection</button>
      <button data-cmd="corriger">Corriger la sélection</button>
    </div>
  </div>
  <form id="barre" class="barre">
    <textarea id="saisie" rows="1" placeholder="Posez votre question…" aria-label="Votre question"></textarea>
    <div class="actions">
      <button type="button" id="pastille" class="pastille" title="Paramètres et connexion"><span class="point"></span><span id="pastilleTexte">…</span></button>
      <button type="button" id="fichier" class="puce" aria-pressed="false" title="Joindre la sélection ou le fichier actif">📎 <span id="fichierNom">Fichier actif</span></button>
      <span class="espace"></span>
      <button type="submit" id="envoyer" class="envoyer" aria-label="Envoyer" disabled>↑</button>
    </div>
  </form>
  <script nonce="${nonce}" src="${uri("markdown.js")}"></script>
  <script nonce="${nonce}" src="${uri("chat.js")}"></script>
</body></html>`;
  }

  poster(message) {
    this.vue?.webview.postMessage(message);
  }

  conv() {
    return this.donnees.conversations().find((c) => c.id === this.courante) ?? null;
  }

  async pousserEtat() {
    if (!this.vue) return;
    const ed = vscode.window.activeTextEditor ?? dernierEditeur;
    this.poster({
      type: "etat",
      liste: this.donnees.conversations().map(({ id, titre, maj }) => ({ id, titre, maj })),
      courante: this.conv(),
      statut: await this.donnees.statut(),
      fichierActif: ed ? vscode.workspace.asRelativePath(ed.document.uri).split(/[\\/]/).pop() : null,
      enCours: !!this.enCours,
    });
  }

  async recevoir(m) {
    switch (m?.type) {
      case "prete":
        this.prete = true;
        await this.pousserEtat();
        if (this.enAttente) {
          const q = this.enAttente;
          this.enAttente = null;
          await this.envoyer(q.texte, q);
        }
        break;
      case "envoyer":
        await this.envoyer(m.texte, { joindre: !!m.joindre });
        break;
      case "arreter":
        this.enCours?.abort();
        break;
      case "nouvelle":
        this.nouvelle();
        break;
      case "ouvrir":
        this.courante = m.id;
        await this.pousserEtat();
        break;
      case "supprimer": {
        await this.donnees.sauverConversations(this.donnees.conversations().filter((c) => c.id !== m.id));
        if (this.courante === m.id) this.courante = null;
        await this.pousserEtat();
        break;
      }
      case "parametres":
        await vscode.commands.executeCommand("orchestrateurIA.parametres");
        break;
      case "commande":
        if (m.nom === "expliquer" || m.nom === "corriger") await vscode.commands.executeCommand(`orchestrateurIA.${m.nom}`);
        break;
      case "avis": {
        // 👍 / 👎 : enregistré dans l'historique et envoyé à l'orchestrateur
        const note = m.note === 1 || m.note === -1 ? m.note : 0;
        const liste = this.donnees.conversations();
        const c = liste.find((x) => x.messages.some((y) => y.echantillon === m.id));
        if (c) {
          c.messages.find((y) => y.echantillon === m.id).avis = note;
          await this.donnees.sauverConversations(liste);
        }
        envoyerAvis(this.donnees.url, String(m.id), note).catch(() => {});
        break;
      }
      case "copier":
        await vscode.env.clipboard.writeText(String(m.code ?? ""));
        break;
      case "inserer":
        await inserer(String(m.code ?? ""));
        break;
    }
  }

  nouvelle() {
    if (this.enCours) this.enCours.abort();
    this.courante = null;
    this.pousserEtat();
  }

  /** Affiche la vue puis envoie une question (utilisé par les commandes). */
  async demander(texte, options) {
    await vscode.commands.executeCommand("orchestrateurIA.chat.focus");
    if (this.vue && this.prete) await this.envoyer(texte, options);
    else this.enAttente = { texte, ...options };
  }

  /**
   * @param {string} texte
   * @param {{ joindre?: boolean, contexte?: object, tache?: string }} options
   */
  async envoyer(texte, { joindre = false, contexte = null, tache = null } = {}) {
    texte = String(texte ?? "").trim();
    if (!texte || this.enCours) return;
    if (!contexte && joindre) contexte = contexteEditeur(this.donnees.contexteMax);
    demanderPartageUneFois(this.ctx, this.donnees); // sans attendre : la question part tout de suite

    const liste = this.donnees.conversations();
    let c = liste.find((x) => x.id === this.courante);
    if (!c) {
      c = { id: crypto.randomUUID(), titre: texte.replace(/\s+/g, " ").slice(0, 60), messages: [], maj: Date.now() };
      liste.unshift(c);
      this.courante = c.id;
    }
    const question = { role: "user", content: texte };
    if (contexte) question.contexte = contexte;
    c.messages.push(question);
    const aEnvoyer = messagesPourModele(c.messages);
    const reponse = { role: "assistant", content: "" };
    c.messages.push(reponse);
    c.maj = Date.now();
    await this.donnees.sauverConversations(liste);

    this.enCours = new AbortController();
    await this.pousserEtat();
    this.poster({ type: "debut", id: c.id });

    try {
      const res = await appeler({
        url: this.donnees.url,
        installId: await this.donnees.installId(),
        keys: await this.donnees.cles(),
        adminKey: await this.donnees.cleAdmin(),
        partage: this.donnees.partage,
        messages: aEnvoyer,
        tache: tache ?? (contexte ? "code" : null),
        stream: true,
        signal: this.enCours.signal,
      });
      const reste = res.headers.get("x-trial-remaining");
      if (reste !== null) await this.donnees.noterEssai(Number(reste));
      reponse.modele = res.headers.get("x-routed-to");
      const echantillon = res.headers.get("x-echantillon-id");
      if (echantillon) reponse.echantillon = echantillon; // permet de noter la réponse
      const connaissances = res.headers.get("x-connaissances");
      if (connaissances) reponse.connaissances = connaissances; // "domaine;nombre de fiches"
      await lireReponse(res, (morceau) => {
        reponse.content += morceau;
        this.poster({ type: "delta", id: c.id, texte: morceau });
      });
    } catch (e) {
      if (e?.name === "AbortError") {
        if (!reponse.content) reponse.content = "_Réponse arrêtée._";
      } else {
        reponse.content = e?.message ?? String(e);
        reponse.erreur = true;
        reponse.action = e?.action ?? null;
      }
    } finally {
      this.enCours = null;
      c.maj = Date.now();
      // Relire la liste : une autre fenêtre a pu la modifier pendant la réponse.
      const a_jour = this.donnees.conversations().filter((x) => x.id !== c.id);
      await this.donnees.sauverConversations([c, ...a_jour]);
      await this.pousserEtat();
    }
  }
}

// ---------------------------------------------------------------- Consentement

/** Demande une seule fois si l'utilisateur accepte le partage anonymisé de ses conversations. */
async function demanderPartageUneFois(ctx, donnees) {
  if (ctx.globalState.get("partageDemande") || (await donnees.cleAdmin())) return;
  await ctx.globalState.update("partageDemande", true);
  const choix = await vscode.window.showInformationMessage(
    "Aidez à améliorer l'assistant : acceptez-vous que vos conversations, anonymisées, servent à enrichir ses connaissances et à entraîner notre modèle ? (modifiable dans les réglages)",
    "Oui, j'accepte",
    "Non merci",
  );
  if (choix) {
    await vscode.workspace
      .getConfiguration("orchestrateurIA")
      .update("partagerConversations", choix === "Oui, j'accepte", vscode.ConfigurationTarget.Global);
  }
}

// ---------------------------------------------------------------- Actions

async function inserer(code) {
  const ed = vscode.window.activeTextEditor ?? dernierEditeur;
  if (!ed) {
    await vscode.env.clipboard.writeText(code);
    vscode.window.showInformationMessage("Aucun éditeur ouvert : le code a été copié.");
    return;
  }
  await ed.edit((e) => {
    if (ed.selection.isEmpty) e.insert(ed.selection.active, code);
    else e.replace(ed.selection, code);
  });
  await vscode.window.showTextDocument(ed.document, ed.viewColumn);
}

async function testerCle(donnees, fournisseur, cle) {
  const res = await appeler({
    url: donnees.url,
    installId: await donnees.installId(),
    keys: { [fournisseur]: cle },
    messages: [{ role: "user", content: "Réponds seulement : OK" }],
    maxTokens: 5,
  });
  await res.json();
  return res.headers.get("x-routed-to");
}

async function commandeConnecter(donnees, vue) {
  try {
    const cle = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: "Connexion à OpenRouter : terminez dans votre navigateur…",
        cancellable: true,
      },
      (_p, annulation) =>
        connecterOpenRouter(
          async (url) => {
            const ok = await vscode.env.openExternal(vscode.Uri.parse(url, true));
            if (!ok) throw new Error("Impossible d'ouvrir le navigateur.");
          },
          async (local) => (await vscode.env.asExternalUri(vscode.Uri.parse(local))).toString(true),
          { annulation },
        ),
    );
    await donnees.definirCle("openrouter", cle);
    vscode.window.showInformationMessage("Connecté à OpenRouter.");
  } catch (e) {
    const choix = await vscode.window.showErrorMessage(
      `Connexion OpenRouter impossible : ${e.message}`,
      "Coller une clé à la place",
    );
    if (choix) await commandeAjouterCle(donnees, vue, "openrouter");
  } finally {
    await vue.pousserEtat();
  }
}

async function commandeAjouterCle(donnees, vue, fournisseurImpose) {
  let fournisseur = fournisseurImpose;
  if (!fournisseur) {
    const choix = await vscode.window.showQuickPick(
      Object.entries(FOURNISSEURS).map(([id, f]) => ({ label: f.nom, description: f.console, id })),
      { title: "Ajouter une clé gratuite", placeHolder: "Choisissez un fournisseur" },
    );
    if (!choix) return;
    fournisseur = choix.id;
  }
  const f = FOURNISSEURS[fournisseur];
  const ouvrir = await vscode.window.showInformationMessage(
    `Créez une clé gratuite ${f.nom}, puis collez-la à l'étape suivante.`,
    "Ouvrir la console",
    "J'ai déjà une clé",
  );
  if (!ouvrir) return;
  if (ouvrir === "Ouvrir la console") await vscode.env.openExternal(vscode.Uri.parse(f.console));
  const cle = await vscode.window.showInputBox({
    title: `Clé ${f.nom}`,
    prompt: "Collez votre clé. Elle sera stockée dans le coffre sécurisé de l'éditeur.",
    password: true,
    ignoreFocusOut: true,
  });
  if (!cle?.trim()) return;
  try {
    const modele = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Test de la clé ${f.nom}…` },
      () => testerCle(donnees, fournisseur, cle.trim()),
    );
    await donnees.definirCle(fournisseur, cle.trim());
    vscode.window.showInformationMessage(`Clé ${f.nom} valide (modèle : ${modele}). Enregistrée.`);
  } catch (e) {
    vscode.window.showErrorMessage(`Clé ${f.nom} non validée : ${e.message}`);
  }
  await vue.pousserEtat();
}

async function commandeCleAdmin(donnees, vue) {
  const actuelle = await donnees.cleAdmin();
  if (actuelle) {
    const choix = await vscode.window.showQuickPick(
      [
        { label: "$(key) Remplacer la clé administrateur", id: "remplacer" },
        { label: "$(trash) Retirer l'accès administrateur", id: "retirer" },
      ],
      { title: "Accès administrateur actif" },
    );
    if (!choix) return;
    if (choix.id === "retirer") {
      await donnees.definirCleAdmin(null);
      vscode.window.showInformationMessage("Accès administrateur retiré.");
      return vue.pousserEtat();
    }
  }
  const cle = await vscode.window.showInputBox({
    title: "Clé administrateur",
    prompt: "La clé définie dans ADMIN_KEYS sur votre orchestrateur. Stockée dans le coffre sécurisé.",
    password: true,
    ignoreFocusOut: true,
  });
  if (!cle?.trim()) return;
  try {
    const ok = await verifierAdmin(donnees.url, cle.trim());
    if (!ok) throw new Error("clé refusée par l'orchestrateur.");
    await donnees.definirCleAdmin(cle.trim());
    vscode.window.showInformationMessage("Accès administrateur activé : aucune limite.");
  } catch (e) {
    vscode.window.showErrorMessage(`Accès administrateur impossible : ${e.message}`);
  }
  await vue.pousserEtat();
}

async function commandeParametres(donnees, vue) {
  const cles = await donnees.cles();
  const statut = await donnees.statut();
  const items = [];
  if (!cles.openrouter)
    items.push({ label: "$(plug) Se connecter avec OpenRouter", detail: "Gratuit, 1 clic : la clé arrive automatiquement.", id: "connecter" });
  items.push({ label: "$(key) Ajouter une clé", detail: "Gemini, Groq, Mistral ou OpenRouter — plus de capacité.", id: "ajouter" });
  if (Object.keys(cles).length)
    items.push({
      label: "$(trash) Supprimer mes clés",
      detail: `Clés enregistrées : ${Object.keys(cles).map((p) => FOURNISSEURS[p]?.nom ?? p).join(", ")}`,
      id: "supprimer",
    });
  items.push({ label: "$(settings-gear) Adresse de l'orchestrateur", detail: donnees.url, id: "url" });
  items.push({
    label: donnees.partage ? "$(pass-filled) Partage anonymisé : activé" : "$(circle-large-outline) Partage anonymisé : désactivé",
    detail: "Vos conversations anonymisées aident à enrichir la base de connaissances et à entraîner le modèle.",
    id: "partage",
  });
  if (statut.admin)
    items.push({ label: "$(book) Base de connaissances", detail: "Ouvrir le tableau de bord dans le navigateur.", id: "tableau" });
  items.push({
    label: "$(shield) Accès administrateur",
    detail: statut.admin ? "Actif : aucune limite." : "Réservé au propriétaire de l'orchestrateur.",
    id: "admin",
  });

  const choix = await vscode.window.showQuickPick(items, {
    title: `Assistant IA — ${statut.admin ? "Administrateur" : statut.connecte ? "Connecté" : statut.libelle.replace("Essai", "Mode essai")}`,
    placeHolder: "Que voulez-vous faire ?",
  });
  if (!choix) return;
  if (choix.id === "connecter") await commandeConnecter(donnees, vue);
  if (choix.id === "ajouter") await commandeAjouterCle(donnees, vue);
  if (choix.id === "supprimer") await vscode.commands.executeCommand("orchestrateurIA.supprimerCles");
  if (choix.id === "url") await vscode.commands.executeCommand("workbench.action.openSettings", "orchestrateurIA.url");
  if (choix.id === "admin") await commandeCleAdmin(donnees, vue);
  if (choix.id === "tableau") await vscode.commands.executeCommand("orchestrateurIA.baseConnaissances");
  if (choix.id === "partage") {
    await vscode.workspace
      .getConfiguration("orchestrateurIA")
      .update("partagerConversations", !donnees.partage, vscode.ConfigurationTarget.Global);
    vscode.window.showInformationMessage(`Partage anonymisé ${donnees.partage ? "activé" : "désactivé"}.`);
  }
}

// ---------------------------------------------------------------- Activation

/** @param {vscode.ExtensionContext} ctx */
function activate(ctx) {
  const donnees = new Donnees(ctx);
  const vue = new VueChat(ctx, donnees);

  const commande = (id, f) => ctx.subscriptions.push(vscode.commands.registerCommand(id, f));

  ctx.subscriptions.push(
    vscode.window.registerWebviewViewProvider("orchestrateurIA.chat", vue, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) dernierEditeur = ed;
      vue.pousserEtat();
    }),
    ctx.secrets.onDidChange(() => vue.pousserEtat()),
  );

  commande("orchestrateurIA.ouvrir", () => vscode.commands.executeCommand("orchestrateurIA.chat.focus"));
  commande("orchestrateurIA.nouvelle", () => vue.nouvelle());

  const surSelection = (consigne) => async () => {
    const contexte = contexteEditeur(donnees.contexteMax, { selectionSeulement: true });
    if (!contexte) return vscode.window.showInformationMessage("Sélectionnez d'abord du code dans l'éditeur.");
    vue.courante = null; // nouvelle conversation pour chaque action
    await vue.demander(consigne, { contexte, tache: "code" });
  };
  commande("orchestrateurIA.expliquer", surSelection("Explique clairement ce que fait ce code, étape par étape."));
  commande(
    "orchestrateurIA.corriger",
    surSelection(
      "Trouve les bugs et les points à améliorer dans ce code, puis donne la version corrigée complète dans un seul bloc de code.",
    ),
  );

  commande("orchestrateurIA.parametres", () => commandeParametres(donnees, vue));
  commande("orchestrateurIA.connecterOpenRouter", () => commandeConnecter(donnees, vue));
  commande("orchestrateurIA.ajouterCle", () => commandeAjouterCle(donnees, vue));
  commande("orchestrateurIA.cleAdmin", () => commandeCleAdmin(donnees, vue));
  commande("orchestrateurIA.baseConnaissances", () =>
    vscode.env.openExternal(vscode.Uri.parse(`${donnees.url.replace(/\/+$/, "")}/admin/`)),
  );
  commande("orchestrateurIA.supprimerCles", async () => {
    const ok = await vscode.window.showWarningMessage("Supprimer toutes vos clés ?", { modal: true }, "Supprimer");
    if (ok) {
      await donnees.effacerCles();
      await vue.pousserEtat();
    }
  });

  return { vue, donnees }; // utile pour les tests
}

function deactivate() {}

module.exports = { activate, deactivate };
