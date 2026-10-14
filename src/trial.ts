// Mode essai : un nouvel utilisateur peut utiliser l'extension sans aucune clé,
// sur les clés du serveur, avec une petite limite par jour.
// Deux compteurs : par installation (X-Install-Id) et par adresse IP (anti-abus).

import type { Env } from "./config";
import { keyFingerprint } from "./quota";

export interface TrialStore {
  /** Incrémente le compteur (id, jour) et renvoie la nouvelle valeur. */
  increment(id: string, day: string): Promise<number>;
  /** Supprime les compteurs antérieurs à ce jour. */
  purgeBefore(day: string): Promise<void>;
}

/** Stockage durable et partagé entre toutes les instances (Cloudflare D1, gratuit). */
export class D1TrialStore implements TrialStore {
  constructor(private db: D1Database) {}

  async increment(id: string, day: string): Promise<number> {
    const row = await this.db
      .prepare(
        "INSERT INTO trial_usage (id, day, count) VALUES (?1, ?2, 1) " +
          "ON CONFLICT(id, day) DO UPDATE SET count = count + 1 RETURNING count",
      )
      .bind(id, day)
      .first<{ count: number }>();
    return row?.count ?? 1;
  }

  async purgeBefore(day: string): Promise<void> {
    await this.db.prepare("DELETE FROM trial_usage WHERE day < ?1").bind(day).run();
  }
}

/** Repli sans D1 : compteur en mémoire, propre à chaque instance (approximatif). */
const memoryCounts = new Map<string, number>();
export class MemoryTrialStore implements TrialStore {
  async increment(id: string, day: string): Promise<number> {
    const k = `${day}|${id}`;
    const n = (memoryCounts.get(k) ?? 0) + 1;
    memoryCounts.set(k, n);
    return n;
  }
  async purgeBefore(day: string): Promise<void> {
    for (const k of memoryCounts.keys()) if (k.slice(0, 10) < day) memoryCounts.delete(k);
  }
}

export function resetTrialMemory(): void {
  memoryCounts.clear();
}

export function trialStore(env: Env): TrialStore {
  return env.TRIAL_DB ? new D1TrialStore(env.TRIAL_DB) : new MemoryTrialStore();
}

export const today = (now = new Date()) => now.toISOString().slice(0, 10); // jour UTC

/** Secondes jusqu'à minuit UTC (remise à zéro des compteurs). */
export function secondsUntilUtcMidnight(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

export const INSTALL_ID_RE = /^[A-Za-z0-9-]{16,64}$/;

export type TrialResult =
  | { allowed: true; remaining: number; limit: number }
  | { allowed: false; reason: "install_limit" | "ip_limit" | "unavailable"; limit: number };

export async function consumeTrial(env: Env, installId: string, ip: string | null): Promise<TrialResult> {
  const limit = positiveInt(env.TRIAL_DAILY_LIMIT, 20);
  const ipLimit = positiveInt(env.TRIAL_IP_DAILY_LIMIT, 60);
  const store = trialStore(env);
  const day = today();
  try {
    // L'IP n'est jamais stockée en clair : seulement une empreinte.
    if (ip) {
      const ipCount = await store.increment(`ip:${await keyFingerprint(ip)}`, day);
      if (ipCount > ipLimit) return { allowed: false, reason: "ip_limit", limit };
    }
    const count = await store.increment(`inst:${installId}`, day);
    if (count > limit) return { allowed: false, reason: "install_limit", limit };
    return { allowed: true, remaining: limit - count, limit };
  } catch {
    // Compteur indisponible (ex. limite d'écriture D1 atteinte) : on refuse l'essai
    // plutôt que de laisser épuiser les clés du serveur.
    return { allowed: false, reason: "unavailable", limit };
  }
}

function positiveInt(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
