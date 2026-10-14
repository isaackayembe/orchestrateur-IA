// Petite imitation de Cloudflare D1 au-dessus du SQLite intégré à Node (22.5+),
// pour tester la base de connaissances avec un vrai SQLite et un vrai FTS5.
import { DatabaseSync } from "node:sqlite";

type Valeur = string | number | bigint | null | Uint8Array;

function convertir(v: unknown): Valeur {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  return v as Valeur;
}

export function d1Memoire(schema: string): D1Database {
  const db = new DatabaseSync(":memory:");
  db.exec(schema);

  const instruction = (sql: string, vals: unknown[] = []): D1PreparedStatement & { _sql: string; _vals: unknown[] } => {
    const args = () => vals.map(convertir);
    const ligne = (r: unknown) => (r ? { ...(r as object) } : null);
    return {
      _sql: sql,
      _vals: vals,
      bind: (...v: unknown[]) => instruction(sql, v),
      first: async <T>(col?: string) => {
        const r = ligne(db.prepare(sql).get(...args())) as Record<string, unknown> | null;
        return (r && col ? r[col] : r) as T;
      },
      all: async <T>() => ({ results: db.prepare(sql).all(...args()).map(ligne) as T[], success: true }),
      run: async <T>() => {
        db.prepare(sql).run(...args());
        return { results: [] as T[], success: true };
      },
    } as unknown as D1PreparedStatement & { _sql: string; _vals: unknown[] };
  };

  return {
    prepare: (sql: string) => instruction(sql),
    batch: async (liste: D1PreparedStatement[]) => {
      db.exec("BEGIN");
      try {
        const sorties = [];
        for (const s of liste) {
          const st = s as unknown as { _sql: string; all: () => Promise<unknown>; run: () => Promise<unknown> };
          sorties.push(/^\s*select/i.test(st._sql) ? await st.all() : await st.run());
        }
        db.exec("COMMIT");
        return sorties;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  } as unknown as D1Database;
}
