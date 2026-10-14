// Vue du chat dans VS Code. Elle n'appelle jamais l'IA elle-même :
// elle envoie des messages à l'extension, qui détient les clés.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);

  let etat = { liste: [], courante: null, statut: { libelle: "…" }, fichierActif: null, enCours: false };
  let joindre = (vscode.getState() || {}).joindre === true;
  let flux = null; // { id, texte } pendant une réponse
  let image = 0;

  // ---------- Rendu ----------

  function bouton(texte, titre, action) {
    const b = document.createElement("button");
    b.textContent = texte;
    b.title = titre;
    b.addEventListener("click", action);
    return b;
  }

  function outilsCode(racine) {
    for (const pre of racine.querySelectorAll("pre")) {
      const code = () => pre.querySelector("code").textContent;
      const barre = document.createElement("div");
      barre.className = "outils";
      barre.append(
        bouton("Insérer", "Insérer dans l'éditeur (remplace la sélection)", () =>
          vscode.postMessage({ type: "inserer", code: code() }),
        ),
        bouton("Copier", "Copier le code", (ev) => {
          vscode.postMessage({ type: "copier", code: code() });
          ev.target.textContent = "Copié";
          setTimeout(() => (ev.target.textContent = "Copier"), 1200);
        }),
      );
      pre.append(barre);
    }
  }

  function bulle(m) {
    const el = document.createElement("div");
    el.className = `msg ${m.role}${m.erreur ? " erreur" : ""}`;
    if (m.role === "user") {
      const t = document.createElement("div");
      t.className = "texte";
      t.textContent = m.content;
      if (m.contexte) {
        const puce = document.createElement("div");
        puce.className = "joint";
        puce.textContent = `📎 ${m.contexte.fichier} · ${m.contexte.portee}`;
        t.append(puce);
      }
      el.append(t);
      return el;
    }
    const corps = document.createElement("div");
    corps.className = "corps";
    if (m.erreur) {
      corps.textContent = m.content;
      if (m.action === "connect_openrouter") {
        const b = bouton("Se connecter avec OpenRouter", "", () => vscode.postMessage({ type: "parametres" }));
        b.className = "principal";
        corps.append(document.createElement("br"), b);
      }
    } else {
      corps.innerHTML = window.rendreMarkdown(m.content || "");
      outilsCode(corps);
    }
    el.append(corps);
    if (m.modele) {
      const meta = document.createElement("div");
      meta.className = "meta";
      const [domaine, n] = (m.connaissances || "").split(";");
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
      const b = bouton(icone, titre, () => {
        m.avis = m.avis === note ? 0 : note;
        for (const x of zone.children) x.setAttribute("aria-pressed", String(m.avis !== 0 && x === b));
        vscode.postMessage({ type: "avis", id: m.echantillon, note: m.avis });
      });
      b.setAttribute("aria-label", titre);
      b.setAttribute("aria-pressed", String(m.avis === note));
      zone.append(b);
    }
    return zone;
  }

  function rendreFil() {
    const c = etat.courante;
    const vide = !c || !c.messages.length;
    document.body.classList.toggle("vide", vide);
    $("titre").textContent = c ? c.titre : "Nouvelle conversation";
    const fil = $("fil");
    fil.textContent = "";
    if (vide) return;
    for (const m of c.messages) fil.append(bulle(m));
    if (etat.enCours) fil.lastElementChild?.querySelector(".corps")?.classList.add("curseur");
    fil.scrollTop = fil.scrollHeight;
  }

  function rendreHistorique() {
    const filtre = $("filtre").value.trim().toLowerCase();
    const nav = $("liste");
    nav.textContent = "";
    const liste = etat.liste.filter((c) => !filtre || c.titre.toLowerCase().includes(filtre));
    if (!liste.length) {
      const p = document.createElement("p");
      p.className = "vide-histo";
      p.textContent = filtre ? "Aucun résultat." : "Vos conversations apparaîtront ici.";
      nav.append(p);
      return;
    }
    for (const c of liste) {
      const item = document.createElement("div");
      item.className = `item${c.id === etat.courante?.id ? " active" : ""}`;
      const ouvrir = bouton(c.titre, c.titre, () => {
        vscode.postMessage({ type: "ouvrir", id: c.id });
        basculerHisto(false);
      });
      ouvrir.className = "ouvrir";
      const date = document.createElement("span");
      date.className = "date";
      date.textContent = new Date(c.maj).toLocaleDateString();
      const suppr = bouton("×", "Supprimer", () => vscode.postMessage({ type: "supprimer", id: c.id }));
      suppr.className = "suppr";
      item.append(ouvrir, date, suppr);
      nav.append(item);
    }
  }

  function rendreBarre() {
    $("pastilleTexte").textContent = etat.statut.libelle;
    $("pastille").classList.toggle("connecte", !!etat.statut.connecte);
    $("fichierNom").textContent = etat.fichierActif ?? "Aucun fichier";
    $("fichier").setAttribute("aria-pressed", String(joindre && !!etat.fichierActif));
    $("fichier").disabled = !etat.fichierActif;
    const b = $("envoyer");
    if (etat.enCours) {
      b.textContent = "■";
      b.setAttribute("aria-label", "Arrêter");
      b.disabled = false;
    } else {
      b.textContent = "↑";
      b.setAttribute("aria-label", "Envoyer");
      b.disabled = !$("saisie").value.trim();
    }
  }

  function basculerHisto(ouvrir) {
    $("histo").hidden = !ouvrir;
    if (ouvrir) {
      rendreHistorique();
      $("filtre").focus();
    }
  }

  // ---------- Messages de l'extension ----------

  window.addEventListener("message", (ev) => {
    const m = ev.data;
    if (m.type === "etat") {
      etat = m;
      if (!m.enCours) flux = null;
      rendreFil();
      rendreBarre();
      if (!$("histo").hidden) rendreHistorique();
    } else if (m.type === "debut") {
      flux = { id: m.id, texte: "" };
    } else if (m.type === "delta" && flux && m.id === flux.id && etat.courante?.id === m.id) {
      flux.texte += m.texte;
      if (!image)
        image = requestAnimationFrame(() => {
          image = 0;
          const corps = $("fil").lastElementChild?.querySelector(".corps");
          if (!corps || !flux) return;
          corps.innerHTML = window.rendreMarkdown(flux.texte);
          const fil = $("fil");
          if (fil.scrollHeight - fil.scrollTop - fil.clientHeight < 120) fil.scrollTop = fil.scrollHeight;
        });
    }
  });

  // ---------- Interactions ----------

  const saisie = $("saisie");
  saisie.addEventListener("input", () => {
    saisie.style.height = "auto";
    saisie.style.height = `${Math.min(saisie.scrollHeight, 180)}px`;
    rendreBarre();
  });
  saisie.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $("barre").requestSubmit();
    }
  });
  $("barre").addEventListener("submit", (e) => {
    e.preventDefault();
    if (etat.enCours) return vscode.postMessage({ type: "arreter" });
    const texte = saisie.value.trim();
    if (!texte) return;
    saisie.value = "";
    saisie.style.height = "auto";
    vscode.postMessage({ type: "envoyer", texte, joindre: joindre && !!etat.fichierActif });
  });
  $("fichier").addEventListener("click", () => {
    joindre = !joindre;
    vscode.setState({ joindre });
    rendreBarre();
  });
  $("pastille").addEventListener("click", () => vscode.postMessage({ type: "parametres" }));
  $("btnNouveau").addEventListener("click", () => {
    basculerHisto(false);
    vscode.postMessage({ type: "nouvelle" });
  });
  $("btnHisto").addEventListener("click", () => basculerHisto($("histo").hidden));
  $("filtre").addEventListener("input", rendreHistorique);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$("histo").hidden) basculerHisto(false);
  });
  for (const b of document.querySelectorAll("[data-cmd]"))
    b.addEventListener("click", () => vscode.postMessage({ type: "commande", nom: b.dataset.cmd }));

  vscode.postMessage({ type: "prete" });
})();
