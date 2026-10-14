-- Base de connaissances (« fichiers » par domaine) et données d'entraînement.
-- Base D1 séparée : npx wrangler d1 create orchestrateur-savoir
-- Appliquer avec : npx wrangler d1 execute orchestrateur-savoir --remote --file=schema-savoir.sql
-- Remarque : une base D1 contenant une table FTS5 ne peut pas être exportée avec « wrangler d1 export ».
-- Les sauvegardes se font depuis le tableau de bord (/admin) : fichiers .md et export .jsonl.

-- Domaines de connaissance : chacun correspond à un « fichier » (design, comptabilité…)
CREATE TABLE IF NOT EXISTS domaines (
  id          TEXT PRIMARY KEY,               -- ex. "comptabilite"
  nom         TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  mots_cles   TEXT NOT NULL DEFAULT '',       -- séparés par des virgules, servent à détecter le domaine
  cree        INTEGER NOT NULL
);

-- Fiches de connaissance : une méthode, une règle, un exemple…
CREATE TABLE IF NOT EXISTS connaissances (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  domaine  TEXT    NOT NULL,
  titre    TEXT    NOT NULL,
  contenu  TEXT    NOT NULL,
  statut   TEXT    NOT NULL DEFAULT 'attente', -- attente | valide | rejete
  epingle  INTEGER NOT NULL DEFAULT 0,         -- 1 = toujours fournie à l'IA pour ce domaine
  source   TEXT    NOT NULL DEFAULT 'manuel',  -- manuel | conversation
  modele   TEXT,                               -- modèle qui a produit la conversation d'origine
  cree     INTEGER NOT NULL,
  maj      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS connaissances_domaine ON connaissances (domaine, statut);

-- Index de recherche plein texte (mis à jour par le code, sans déclencheur)
CREATE VIRTUAL TABLE IF NOT EXISTS connaissances_fts
  USING fts5(titre, contenu, tokenize = 'unicode61 remove_diacritics 2');

-- Images d'exemple rattachées à une fiche (compressées par le tableau de bord, 1,5 Mo max)
CREATE TABLE IF NOT EXISTS images (
  id           TEXT    PRIMARY KEY,
  connaissance INTEGER NOT NULL,
  legende      TEXT    NOT NULL DEFAULT '',
  type         TEXT    NOT NULL,
  donnees      BLOB    NOT NULL,
  taille       INTEGER NOT NULL,
  cree         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS images_connaissance ON images (connaissance);

-- Échantillons de conversation (anonymisés, avec consentement) pour entraîner votre modèle
CREATE TABLE IF NOT EXISTS echantillons (
  id       TEXT    PRIMARY KEY,
  domaine  TEXT    NOT NULL,
  messages TEXT    NOT NULL,                  -- JSON : messages user/assistant envoyés
  reponse  TEXT    NOT NULL,
  modele   TEXT,
  mode     TEXT,                              -- admin | byok | trial
  note     INTEGER NOT NULL DEFAULT 0,        -- avis : 1 (👍), -1 (👎), 0 (aucun)
  cree     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS echantillons_cree ON echantillons (cree);

-- Domaines de départ (modifiables dans le tableau de bord)
INSERT OR IGNORE INTO domaines (id, nom, description, mots_cles, cree) VALUES
  ('general', 'Général', 'Connaissances utiles à toutes les questions.', '', 0),
  ('design-ux-ui', 'Design UX/UI',
   'Méthodes de design d''interface et d''expérience utilisateur, avec images d''exemple.',
   'design,ux,ui,interface,maquette,wireframe,prototype,figma,ergonomie,typographie,couleur,palette,accessibilite,bouton,ecran,mise en page,landing,logo', 0),
  ('comptabilite', 'Comptabilité',
   'Comptabilité, fiscalité et gestion, dans le contexte de la RDC (SYSCOHADA, francs congolais et dollars).',
   'comptabilite,comptable,bilan,ecriture,journal,grand livre,syscohada,ohada,tva,impot,facture,tresorerie,amortissement,compte de resultat,debit,credit,dgi,balance,inventaire,caisse', 0),
  ('developpement', 'Développement',
   'Programmation, outils et bonnes pratiques de code.',
   'code,fonction,bug,api,javascript,typescript,python,php,sql,base de donnees,erreur,deployer,git,react,node,serveur', 0);
