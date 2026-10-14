-- Compteurs du mode essai (une ligne par installation ou IP et par jour UTC).
-- Appliquer avec : npx wrangler d1 execute orchestrateur-essai --remote --file=schema.sql
CREATE TABLE IF NOT EXISTS trial_usage (
  id    TEXT    NOT NULL,           -- "inst:<id d'installation>" ou "ip:<empreinte>"
  day   TEXT    NOT NULL,           -- AAAA-MM-JJ (UTC)
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (id, day)
);
