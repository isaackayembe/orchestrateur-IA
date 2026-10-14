// Gestionnaire de quotas : met un modèle "en pause" après un refus,
// jusqu'à l'heure de reset annoncée par le fournisseur.

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

// État en mémoire, partagé par toutes les requêtes d'une même instance.
const pausedUntil = new Map<string, number>();
const lastKvCheck = new Map<string, number>();
const KV_CHECK_EVERY_MS = 30_000; // limite les lectures KV (quota gratuit)

export class Cooldowns {
  constructor(private kv?: KVLike) {}

  /** Millisecondes restantes avant que ce modèle soit de nouveau utilisable (0 = disponible). */
  async remainingMs(id: string): Promise<number> {
    const now = Date.now();
    const local = pausedUntil.get(id) ?? 0;
    if (local > now) return local - now;
    if (this.kv && now - (lastKvCheck.get(id) ?? 0) > KV_CHECK_EVERY_MS) {
      lastKvCheck.set(id, now);
      try {
        const remote = Number(await this.kv.get("cd:" + id));
        if (remote > now) {
          pausedUntil.set(id, remote);
          return remote - now;
        }
      } catch {
        // KV indisponible : on continue avec la mémoire locale
      }
    }
    return 0;
  }

  async coolDown(id: string, ms: number): Promise<void> {
    const until = Date.now() + ms;
    pausedUntil.set(id, until);
    if (pausedUntil.size > 10_000) prune();
    if (this.kv) {
      try {
        // On n'écrit dans KV que lors d'un refus : peu d'écritures.
        await this.kv.put("cd:" + id, String(until), { expirationTtl: Math.max(60, Math.ceil(ms / 1000)) });
      } catch {
        // Limite d'écriture KV atteinte : la mémoire locale suffit.
      }
    }
  }
}

function prune(): void {
  const now = Date.now();
  for (const [k, v] of pausedUntil) if (v <= now) pausedUntil.delete(k);
}

/** Pour les tests. */
export function resetCooldowns(): void {
  pausedUntil.clear();
  lastKvCheck.clear();
}

const MIN_MS = 5_000;
const MAX_MS = 24 * 3600_000;
const DEFAULT_MS = 60_000;
const clamp = (ms: number) => Math.min(MAX_MS, Math.max(MIN_MS, Math.round(ms)));

/** "2m59.56s", "7.66s", "1h", "250ms" -> millisecondes. */
export function parseDuration(s: string): number | null {
  const re = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let total = 0;
  let found = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    found = true;
    const n = parseFloat(m[1]);
    total += m[2] === "h" ? n * 3_600_000 : m[2] === "m" ? n * 60_000 : m[2] === "s" ? n * 1000 : n;
  }
  return found ? total : null;
}

function parseResetValue(v: string): number | null {
  const t = v.trim();
  if (/^\d+(\.\d+)?$/.test(t)) {
    const n = Number(t);
    if (n > 1e12) return n - Date.now(); // horodatage en ms (ex. OpenRouter)
    if (n > 1e9) return n * 1000 - Date.now(); // horodatage en secondes
    return n * 1000; // nombre de secondes
  }
  return parseDuration(t);
}

/** Durée de pause déduite des en-têtes de la réponse 429. */
export function parseRetryMs(headers: Headers): number {
  const ra = headers.get("retry-after");
  if (ra) {
    const n = Number(ra);
    if (Number.isFinite(n)) return clamp(n * 1000);
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return clamp(date - Date.now());
  }
  let best: number | null = null;
  for (const h of ["x-ratelimit-reset-requests", "x-ratelimit-reset-tokens", "x-ratelimit-reset"]) {
    const v = headers.get(h);
    if (!v) continue;
    const ms = parseResetValue(v);
    if (ms !== null && (best === null || ms > best)) best = ms;
  }
  return best !== null ? clamp(best) : DEFAULT_MS;
}

/** Empreinte courte d'une clé : sépare les pauses par clé sans stocker la clé elle-même. */
export async function keyFingerprint(key: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(buf)]
    .slice(0, 6)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
