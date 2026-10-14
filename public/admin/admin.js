// Tableau de bord de la base de connaissances (réservé à l'administrateur).
(function () {
  "use strict";

  const API = location.origin + "/admin/api";
  let cle = null;
  try {
    cle = sessionStorage.getItem("cleAdmin");
  } catch (e) {}

  let domaines = [];
  let onglet = "attente";

  // ---------- Outils ----------

  function h(tag, attrs, ...enfants) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "valeur") el.value = v;
      else if (k === "coche") el.checked = !!v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const e of enfants.flat()) if (e !== null && e !== undefined && e !== false) el.append(e instanceof Node ? e : String(e));
    return el;
  }

  function notifier(texte, erreur) {
    const n = h("div", { class: "notice" + (erreur ? " err" : ""), role: "status" }, texte);
    document.body.append(n);
    setTimeout(() => n.remove(), erreur ? 5000 : 2500);
  }

  async function appel(chemin, options) {
    options = options || {};
    const headers = Object.assign({ authorization: "Bearer " + cle }, options.headers || {});
    if (options.json !== undefined) {
      headers["content-type"] = "application/json";
      options.body = JSON.stringify(options.json);
    }
    const res = await fetch(API + chemin, { method: options.method || "GET", headers: headers, body: options.body });
    if (res.status === 401) {
      deconnecter();
      throw new Error("Clé administrateur refusée.");
    }
    if (options.brut) {
      if (!res.ok) throw new Error("Erreur " + res.status);
      return res;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((data.error && data.error.message) || "Erreur " + res.status);
    return data;
  }

  async function action(bouton, f, succes) {
    if (bouton) bouton.disabled = true;
    try {
      await f();
      if (succes) notifier(succes);
    } catch (e) {
      notifier(e.message, true);
    } finally {
      if (bouton) bouton.disabled = false;
    }
  }

  function telecharger(nom, contenu, type) {
    const url = URL.createObjectURL(new Blob([contenu], { type: type }));
    const a = h("a", { href: url, download: nom });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  const nomDomaine = (id) => (domaines.find((d) => d.id === id) || { nom: id }).nom;
  const date = (t) => new Date(t).toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });

  function choixDomaines(valeur, tous) {
    const s = h("select", {}, tous ? h("option", { value: "" }, "Tous les domaines") : null, domaines.map((d) => h("option", { value: d.id }, d.nom)));
    s.value = valeur || "";
    return s;
  }

  /** Réduit une image (1600 px max, WebP) pour rester sous 1,5 Mo. */
  async function compresser(fichier) {
    if (fichier.type === "image/gif" && fichier.size < 1500000) return fichier;
    const bitmap = await createImageBitmap(fichier);
    const echelle = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bitmap.width * echelle);
    c.height = Math.round(bitmap.height * echelle);
    c.getContext("2d").drawImage(bitmap, 0, 0, c.width, c.height);
    for (const q of [0.85, 0.7, 0.55]) {
      const blob = await new Promise((ok) => c.toBlob(ok, "image/webp", q));
      if (blob && blob.type === "image/webp" && blob.size < 1500000) return blob;
      const jpeg = await new Promise((ok) => c.toBlob(ok, "image/jpeg", q));
      if (jpeg && jpeg.size < 1500000) return jpeg;
    }
    throw new Error("Image trop lourde, même compressée.");
  }

  async function envoyerImage(ficheId, fichier, legende) {
    const blob = await compresser(fichier);
    const form = new FormData();
    form.append("fichier", blob, fichier.name);
    form.append("legende", legende || "");
    return appel("/connaissances/" + ficheId + "/images", { method: "POST", body: form });
  }

  // ---------- Connexion ----------

  function deconnecter() {
    cle = null;
    try {
      sessionStorage.removeItem("cleAdmin");
    } catch (e) {}
    afficherConnexion();
  }

  function afficherConnexion() {
    const champ = h("input", { type: "password", placeholder: "Clé administrateur (ADMIN_KEYS)", autocomplete: "off" });
    const bouton = h("button", { class: "principal", type: "submit" }, "Entrer");
    const form = h(
      "form",
      { class: "carte" },
      h("h1", { style: "margin:0;font-size:22px" }, "Base de connaissances"),
      h("p", { class: "meta", style: "margin:0" }, "Réservé à l'administrateur de l'orchestrateur."),
      champ,
      bouton,
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      cle = champ.value.trim();
      action(bouton, async () => {
        await appel("/resume");
        try {
          sessionStorage.setItem("cleAdmin", cle);
        } catch (e2) {}
        await demarrer();
      });
    });
    document.getElementById("app").replaceChildren(h("div", { class: "connexion" }, form));
    champ.focus();
  }

  // ---------- Structure ----------

  const ONGLETS = [
    ["attente", "À valider"],
    ["fiches", "Fiches"],
    ["ajouter", "Ajouter une fiche"],
    ["domaines", "Domaines"],
    ["entrainement", "Entraînement"],
  ];

  async function demarrer() {
    domaines = (await appel("/domaines")).domaines;
    const nav = h("nav", { role: "tablist" });
    const main = h("main", { id: "contenu" });
    document.getElementById("app").replaceChildren(
      h(
        "header",
        {},
        h("div", { class: "haut" }, h("h1", {}, "Base de connaissances"), h("button", { onclick: deconnecter }, "Se déconnecter")),
        nav,
      ),
      main,
    );
    await rendreNav();
    await afficher(onglet);
  }

  async function rendreNav() {
    const resume = await appel("/resume").catch(() => ({ fiches: [] }));
    const enAttente = (resume.fiches || []).filter((f) => f.statut === "attente").reduce((n, f) => n + f.n, 0);
    const nav = document.querySelector("nav");
    nav.replaceChildren(
      ...ONGLETS.map(([id, nom]) =>
        h(
          "button",
          { role: "tab", "aria-selected": String(id === onglet), onclick: () => afficher(id) },
          nom,
          id === "attente" && enAttente ? h("span", { class: "compte" }, enAttente) : null,
        ),
      ),
    );
  }

  async function afficher(id) {
    onglet = id;
    document.querySelectorAll("nav button").forEach((b, i) => b.setAttribute("aria-selected", String(ONGLETS[i][0] === id)));
    const main = document.getElementById("contenu");
    main.replaceChildren(h("p", { class: "meta" }, "Chargement…"));
    try {
      const vues = { attente: vueAttente, fiches: vueFiches, ajouter: vueAjouter, domaines: vueDomaines, entrainement: vueEntrainement };
      main.replaceChildren(...[].concat(await vues[id]()));
    } catch (e) {
      main.replaceChildren(h("p", { class: "vide" }, e.message));
    }
  }

  // ---------- Carte d'une fiche (modifiable) ----------

  function carteFiche(f, images, options) {
    const titre = h("input", { valeur: f.titre });
    const contenu = h("textarea", {}, f.contenu);
    const domaine = choixDomaines(f.domaine);
    const epingle = h("input", { type: "checkbox", coche: !!f.epingle });
    const carte = h("article", { class: "carte" });

    const enregistrer = (statut, bouton, message) =>
      action(
        bouton,
        async () => {
          const champs = { titre: titre.value, contenu: contenu.value, domaine: domaine.value, epingle: epingle.checked };
          if (statut) champs.statut = statut;
          await appel("/connaissances/" + f.id, { method: "PATCH", json: champs });
          if (statut && statut !== f.statut) carte.remove();
          await rendreNav();
        },
        message,
      );

    const boutons = [];
    if (f.statut !== "valide")
      boutons.push(h("button", { class: "principal", onclick: (e) => enregistrer("valide", e.target, "Fiche validée : l'IA l'utilisera.") }, "Valider"));
    else boutons.push(h("button", { class: "principal", onclick: (e) => enregistrer(null, e.target, "Enregistré.") }, "Enregistrer"));
    if (f.statut !== "rejete") boutons.push(h("button", { onclick: (e) => enregistrer("rejete", e.target, "Fiche rejetée.") }, "Rejeter"));
    boutons.push(
      h(
        "button",
        {
          class: "danger",
          onclick: (e) =>
            confirm("Supprimer définitivement cette fiche et ses images ?") &&
            action(e.target, async () => {
              await appel("/connaissances/" + f.id, { method: "DELETE" });
              carte.remove();
              await rendreNav();
            }, "Fiche supprimée."),
        },
        "Supprimer",
      ),
    );

    const zoneImages = h("div", { class: "images" });
    const ajouterVignette = (im) =>
      zoneImages.append(
        h(
          "figure",
          { class: "image", style: "margin:0" },
          h("img", { src: location.origin + "/images/" + im.id, alt: im.legende || "", loading: "lazy" }),
          h("span", { title: im.legende }, im.legende || "Sans légende"),
          h(
            "button",
            {
              title: "Retirer l'image",
              "aria-label": "Retirer l'image",
              onclick: (e) =>
                action(e.target, async () => {
                  await appel("/images/" + im.id, { method: "DELETE" });
                  e.target.closest("figure").remove();
                }),
            },
            "×",
          ),
        ),
      );
    (images || []).forEach(ajouterVignette);

    const fichierImage = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif" });
    const legende = h("input", { placeholder: "Ex. : bon exemple de formulaire accessible" });
    const boutonImage = h("button", {}, "Ajouter l'image");
    boutonImage.addEventListener("click", () => {
      const fichier = fichierImage.files[0];
      if (!fichier) return notifier("Choisissez une image.", true);
      action(boutonImage, async () => {
        const im = await envoyerImage(f.id, fichier, legende.value);
        ajouterVignette({ id: im.id, legende: legende.value });
        fichierImage.value = "";
        legende.value = "";
      }, "Image ajoutée.");
    });

    carte.append(
      h(
        "div",
        { class: "ligne" },
        h("span", { class: "badge " + f.statut }, { attente: "À valider", valide: "Validée", rejete: "Rejetée" }[f.statut]),
        h("span", { class: "meta" }, (f.source === "conversation" ? "Apprise d'une conversation" : "Ajoutée à la main") + (f.modele ? " · " + f.modele : "") + " · " + date(f.maj)),
      ),
      h("div", { class: "grille2" }, h("label", {}, "Domaine", domaine), h("label", {}, "Titre", titre)),
      h("label", {}, "Contenu", contenu),
      h("label", { class: "case" }, epingle, "Épinglée : toujours donnée à l'IA pour ce domaine (charte, règles de base…)"),
      options && options.sansImages ? null : zoneImages,
      options && options.sansImages
        ? null
        : h("div", { class: "ajout-image" }, h("label", {}, "Image d'exemple", fichierImage), h("label", {}, "Légende (aide l'IA à savoir quand la montrer)", legende), boutonImage),
      h("div", { class: "ligne fin" }, boutons),
    );
    return carte;
  }

  // ---------- Vues ----------

  async function vueAttente() {
    const data = await appel("/connaissances?statut=attente");
    const intro = h(
      "p",
      { class: "intro" },
      "Fiches tirées automatiquement des conversations. Relisez-les, corrigez-les si besoin, puis validez : seules les fiches validées sont utilisées par l'IA.",
    );
    if (!data.connaissances.length) return [intro, h("p", { class: "vide" }, "Rien à valider pour le moment.")];
    return [intro, h("div", { class: "liste" }, data.connaissances.map((f) => carteFiche(f, data.images.filter((i) => i.connaissance === f.id))))];
  }

  async function vueFiches() {
    const filtreDomaine = choixDomaines("", true);
    const filtreStatut = h(
      "select",
      {},
      h("option", { value: "valide" }, "Validées"),
      h("option", { value: "rejete" }, "Rejetées"),
      h("option", { value: "" }, "Toutes"),
    );
    const recherche = h("input", { type: "search", placeholder: "Rechercher un mot…" });
    const fichier = h("button", {}, "Télécharger le fichier .md");
    const liste = h("div", { class: "liste" });

    async function charger() {
      const p = new URLSearchParams();
      if (filtreDomaine.value) p.set("domaine", filtreDomaine.value);
      if (filtreStatut.value) p.set("statut", filtreStatut.value);
      if (recherche.value.trim()) p.set("q", recherche.value.trim());
      const data = await appel("/connaissances?" + p);
      liste.replaceChildren(
        ...(data.connaissances.length
          ? data.connaissances.map((f) => carteFiche(f, data.images.filter((i) => i.connaissance === f.id)))
          : [h("p", { class: "vide" }, "Aucune fiche.")]),
      );
      fichier.disabled = !filtreDomaine.value;
      fichier.title = filtreDomaine.value ? "" : "Choisissez d'abord un domaine";
    }
    let minuterie;
    recherche.addEventListener("input", () => {
      clearTimeout(minuterie);
      minuterie = setTimeout(() => action(null, charger), 300);
    });
    filtreDomaine.addEventListener("change", () => action(null, charger));
    filtreStatut.addEventListener("change", () => action(null, charger));
    fichier.addEventListener("click", () =>
      action(fichier, async () => {
        const res = await appel("/domaines/" + filtreDomaine.value + "/fichier.md", { brut: true });
        telecharger(filtreDomaine.value + ".md", await res.text(), "text/markdown");
      }),
    );
    await charger();
    return [
      h(
        "div",
        { class: "barre-outils" },
        h("label", {}, "Domaine", filtreDomaine),
        h("label", {}, "Statut", filtreStatut),
        h("label", {}, "Recherche", recherche),
        fichier,
      ),
      liste,
    ];
  }

  function vueAjouter() {
    const domaine = choixDomaines(domaines.find((d) => d.id !== "general") ? domaines.find((d) => d.id !== "general").id : "general");
    const titre = h("input", { placeholder: "Ex. : Hiérarchie visuelle d'un écran" });
    const contenu = h("textarea", { placeholder: "La méthode, la règle ou l'exemple, rédigé clairement. L'IA s'en servira pour répondre.", style: "min-height:180px" });
    const epingle = h("input", { type: "checkbox" });
    const lignesImages = h("div", { class: "liste" });
    const ajouterLigneImage = () =>
      lignesImages.append(
        h(
          "div",
          { class: "ajout-image", style: "border-top:0;padding-top:0" },
          h("label", {}, "Image", h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif" })),
          h("label", {}, "Légende", h("input", { placeholder: "Ce que montre l'image" })),
        ),
      );
    ajouterLigneImage();
    const bouton = h("button", { class: "principal", type: "submit" }, "Ajouter la fiche");
    const form = h(
      "form",
      { class: "carte" },
      h("div", { class: "grille2" }, h("label", {}, "Domaine", domaine), h("label", {}, "Titre", titre)),
      h("label", {}, "Contenu", contenu),
      h("label", { class: "case" }, epingle, "Épinglée : toujours donnée à l'IA pour ce domaine"),
      h("div", {}, h("p", { class: "meta", style: "margin:0 0 8px" }, "Images d'exemple (facultatif)"), lignesImages, h("button", { type: "button", style: "margin-top:8px", onclick: ajouterLigneImage }, "+ Une autre image")),
      h("div", { class: "ligne fin" }, bouton),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      action(bouton, async () => {
        const { id } = await appel("/connaissances", {
          method: "POST",
          json: { domaine: domaine.value, titre: titre.value, contenu: contenu.value, epingle: epingle.checked, statut: "valide" },
        });
        for (const ligne of lignesImages.children) {
          const [fichier, legende] = ligne.querySelectorAll("input");
          if (fichier.files[0]) await envoyerImage(id, fichier.files[0], legende.value);
        }
        titre.value = "";
        contenu.value = "";
        epingle.checked = false;
        lignesImages.replaceChildren();
        ajouterLigneImage();
      }, "Fiche ajoutée et validée.");
    });
    return [h("p", { class: "intro" }, "Ajoutez vos propres méthodes, règles et exemples. Elles sont validées directement et utilisées par l'IA dès la prochaine question."), form];
  }

  async function vueDomaines() {
    domaines = (await appel("/domaines")).domaines;
    const formulaire = (d) => {
      const id = h("input", { valeur: d ? d.id : "", placeholder: "ex. agriculture", disabled: !!d });
      const nom = h("input", { valeur: d ? d.nom : "", placeholder: "Agriculture" });
      const description = h("input", { valeur: d ? d.description : "", placeholder: "Ce que couvre ce domaine" });
      const mots = h("textarea", { style: "min-height:70px", placeholder: "manioc, culture, récolte, semis…" }, d ? d.mots_cles : "");
      const enregistrer = h("button", { class: "principal", type: "submit" }, d ? "Enregistrer" : "Créer le domaine");
      const boutons = [enregistrer];
      if (d) {
        boutons.unshift(
          h("button", {
            type: "button",
            onclick: (e) =>
              action(e.target, async () => {
                const res = await appel("/domaines/" + d.id + "/fichier.md", { brut: true });
                telecharger(d.id + ".md", await res.text(), "text/markdown");
              }),
          }, "Fichier .md"),
        );
        if (d.id !== "general")
          boutons.unshift(
            h("button", {
              type: "button",
              class: "danger",
              onclick: (e) =>
                confirm("Supprimer le domaine « " + d.nom + " » ?") &&
                action(e.target, async () => {
                  await appel("/domaines/" + d.id, { method: "DELETE" });
                  await afficher("domaines");
                }, "Domaine supprimé."),
            }, "Supprimer"),
          );
      }
      const form = h(
        "form",
        { class: "carte" },
        h("div", { class: "grille2" }, h("label", {}, "Identifiant", id), h("label", {}, "Nom", nom)),
        h("label", {}, "Description", description),
        h("label", {}, "Mots-clés (détection automatique du domaine dans les questions)", mots),
        h("div", { class: "ligne fin" }, boutons),
      );
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        action(enregistrer, async () => {
          await appel("/domaines", { method: "POST", json: { id: id.value.trim(), nom: nom.value, description: description.value, mots_cles: mots.value } });
          await afficher("domaines");
        }, d ? "Domaine enregistré." : "Domaine créé.");
      });
      return form;
    };
    return [
      h("p", { class: "intro" }, "Chaque domaine est un « fichier » de connaissances. Les mots-clés servent à reconnaître le domaine d'une question."),
      h("div", { class: "liste" }, domaines.map(formulaire)),
      h("h2", { style: "font-size:17px;margin:24px 0 10px" }, "Nouveau domaine"),
      formulaire(null),
    ];
  }

  async function vueEntrainement() {
    const { lignes } = await appel("/echantillons/stats");
    const total = lignes.reduce((n, l) => n + l.n, 0);
    const licences = { autorise: "Autorisé", a_verifier: "À vérifier", interdit: "Interdit" };

    const tableau = lignes.length
      ? h(
          "div",
          { class: "tableau" },
          h(
            "table",
            {},
            h("tr", {}, h("th", {}, "Modèle d'origine"), h("th", {}, "Domaine"), h("th", {}, "Exemples"), h("th", {}, "👍"), h("th", {}, "👎"), h("th", {}, "Licence")),
            lignes.map((l) =>
              h(
                "tr",
                {},
                h("td", {}, l.modele || "inconnu"),
                h("td", {}, nomDomaine(l.domaine)),
                h("td", { class: "nombre" }, l.n),
                h("td", { class: "nombre" }, l.bons || 0),
                h("td", { class: "nombre" }, l.mauvais || 0),
                h("td", {}, h("span", { class: "badge " + l.licence.statut, title: l.licence.note }, licences[l.licence.statut]), h("div", { class: "meta" }, l.licence.note)),
              ),
            ),
          ),
        )
      : h("p", { class: "vide" }, "Aucun exemple pour l'instant. Ils arrivent avec vos conversations et celles des utilisateurs qui acceptent le partage.");

    const domaine = choixDomaines("", true);
    const avis = h(
      "select",
      {},
      h("option", { value: "0" }, "Sans les réponses notées 👎"),
      h("option", { value: "1" }, "Seulement les réponses notées 👍"),
      h("option", { value: "-1" }, "Toutes"),
    );
    const licence = h("select", {}, h("option", { value: "autorise" }, "Seulement les modèles autorisés"), h("option", { value: "tout" }, "Tous (à vos risques)"));
    const avert = h("p", { class: "avertissement", hidden: true }, "Attention : certaines conditions (par exemple celles de l'API Gemini) interdisent d'utiliser leurs réponses pour développer un modèle concurrent. Vérifiez chaque licence avant d'entraîner.");
    licence.addEventListener("change", () => (avert.hidden = licence.value !== "tout"));
    const bouton = h("button", { class: "principal" }, "Exporter le .jsonl");
    bouton.addEventListener("click", () =>
      action(bouton, async () => {
        const morceaux = [];
        let apres = 0;
        let ignores = 0;
        for (;;) {
          const p = new URLSearchParams({ apres: String(apres), noteMin: avis.value, licence: licence.value });
          if (domaine.value) p.set("domaine", domaine.value);
          const page = await appel("/echantillons/export?" + p);
          for (const l of page.lignes) morceaux.push(JSON.stringify(l));
          ignores += page.ignores;
          if (!page.suivant) break;
          apres = page.suivant;
        }
        if (!morceaux.length) throw new Error("Aucun exemple ne correspond à ces filtres." + (ignores ? " (" + ignores + " écartés pour raison de licence)" : ""));
        telecharger("entrainement-" + (domaine.value || "tous") + "-" + new Date().toISOString().slice(0, 10) + ".jsonl", morceaux.join("\n") + "\n", "application/jsonl");
        notifier(morceaux.length + " exemples exportés" + (ignores ? ", " + ignores + " écartés (licence)." : "."));
      }),
    );

    return [
      h(
        "p",
        { class: "intro" },
        total + (total > 1 ? " exemples" : " exemple") + " de conversations anonymisées. Exportez-les au format chat (.jsonl) pour entraîner votre propre modèle : voir le guide ENTRAINEMENT.md du projet.",
      ),
      tableau,
      h("h2", { style: "font-size:17px;margin:24px 0 10px" }, "Exporter les données d'entraînement"),
      h("div", { class: "carte" }, h("div", { class: "barre-outils", style: "margin:0" }, h("label", {}, "Domaine", domaine), h("label", {}, "Qualité", avis), h("label", {}, "Licence", licence)), avert, h("div", { class: "ligne fin" }, bouton)),
    ];
  }

  // ---------- Démarrage ----------

  if (cle) demarrer().catch(() => afficherConnexion());
  else afficherConnexion();
})();
