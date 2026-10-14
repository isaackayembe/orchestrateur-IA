// Copie du rendu Markdown de l extension navigateur (script classique pour la vue VS Code).
"use strict";
// Rendu Markdown minimal et sûr (tout le texte est échappé avant mise en forme).
// Gère : blocs de code ```, `code`, **gras**, *italique*, titres #, listes, paragraphes, images et liens.

const esc = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Images et liens : seulement des adresses http(s), le texte étant déjà échappé.
function liens(s) {
  return s
    .replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function inline(s) {
  return esc(s)
    .split(/(`[^`]+`)/)
    .map((morceau, i) =>
      i % 2
        ? `<code>${morceau.slice(1, -1)}</code>`
        : liens(morceau)
            .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
            .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>"),
    )
    .join("");
}

function blocTexte(t) {
  const out = [];
  let liste = null; // "ul" | "ol"
  let para = [];
  const fermerPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const fermerListe = () => {
    if (liste) out.push(`</${liste}>`);
    liste = null;
  };
  for (const ligne of t.split("\n")) {
    const titre = ligne.match(/^(#{1,4})\s+(.*)$/);
    const puce = ligne.match(/^\s*[-*]\s+(.*)$/);
    const num = ligne.match(/^\s*\d+[.)]\s+(.*)$/);
    if (titre) {
      fermerPara();
      fermerListe();
      out.push(`<h${titre[1].length + 2}>${inline(titre[2])}</h${titre[1].length + 2}>`);
    } else if (puce || num) {
      fermerPara();
      const type = puce ? "ul" : "ol";
      if (liste !== type) {
        fermerListe();
        out.push(`<${type}>`);
        liste = type;
      }
      out.push(`<li>${inline((puce ?? num)[1])}</li>`);
    } else if (!ligne.trim()) {
      fermerPara();
      fermerListe();
    } else {
      fermerListe();
      para.push(ligne);
    }
  }
  fermerPara();
  fermerListe();
  return out.join("");
}

function rendreMarkdown(src) {
  // Les morceaux impairs sont du code (un bloc non fermé, en cours de flux, reste du code).
  return src
    .split("```")
    .map((p, i) => {
      if (i % 2 === 0) return blocTexte(p);
      const nl = p.indexOf("\n");
      const lang = nl >= 0 ? p.slice(0, nl).trim() : "";
      const code = nl >= 0 ? p.slice(nl + 1) : p;
      return `<pre data-lang="${esc(lang)}"><code>${esc(code.replace(/\n$/, ""))}</code></pre>`;
    })
    .join("");
}
window.rendreMarkdown = rendreMarkdown;
