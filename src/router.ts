// Routeur + bascule : essaie les modèles de la liste dans l'ordre,
// met en pause ceux qui refusent, et renvoie la première réponse valide.

import { MAX_ATTEMPTS, PROVIDER_WIDE_PAUSE_MS, PROVIDERS, ROUTES, UPSTREAM_TIMEOUT_MS } from "./config";
import type { Env, ProviderId, Target, Task } from "./config";
import { Cooldowns, keyFingerprint, parseRetryMs } from "./quota";
import { cibleMonModele, convertirReponse, requeteMonModele } from "./monmodele";

export type KeySet = Partial<Record<ProviderId, string>>;

const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];

/** Clés du serveur (secrets Cloudflare). */
export function serverKeys(env: Env): KeySet {
  const keys: KeySet = {};
  for (const id of PROVIDER_IDS) {
    const v = env[PROVIDERS[id].keyEnv];
    if (typeof v === "string" && v) keys[id] = v;
  }
  return keys;
}

/** Clés fournies par l'utilisateur : "X-Provider-Keys: groq=gsk_...; gemini=AIza..." */
export function parseByok(header: string | null): KeySet {
  const keys: KeySet = {};
  if (!header) return keys;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const id = part.slice(0, i).trim().toLowerCase() as ProviderId;
    const key = part.slice(i + 1).trim();
    if (PROVIDER_IDS.includes(id) && PROVIDERS[id].byok && key) keys[id] = key;
  }
  return keys;
}

/** "groq/openai/gpt-oss-120b" -> modèle forcé ; "auto" -> null. */
export function parseExplicit(model: unknown): Target | null {
  if (typeof model !== "string" || !model || model === "auto") return null;
  const i = model.indexOf("/");
  if (i < 1) return null;
  const provider = model.slice(0, i) as ProviderId;
  if (!PROVIDER_IDS.includes(provider)) return null;
  return { provider, model: model.slice(i + 1) };
}

export function candidates(task: Task, explicit: Target | null, env?: Env): Target[] {
  // Ordre : modèle imposé, puis VOTRE modèle (s'il est configuré pour cette tâche), puis la table.
  const monModele = env ? cibleMonModele(env, task) : null;
  const list = [...(explicit ? [explicit] : []), ...(monModele ? [monModele] : []), ...ROUTES[task]];
  const seen = new Set<string>();
  return list.filter((t) => {
    const k = `${t.provider}/${t.model}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

interface Attempt {
  target: string;
  result: number | "erreur réseau" | "en pause";
  detail?: string;
}

export function json(status: number, data: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extra },
  });
}

export async function routeChat(
  body: Record<string, unknown>,
  task: Task,
  keys: KeySet,
  env: Env,
  cooldowns: Cooldowns,
): Promise<Response> {
  const attempts: Attempt[] = [];
  let tries = 0;
  let soonestMs = Infinity;

  for (const t of candidates(task, parseExplicit(body.model), env)) {
    if (tries >= MAX_ATTEMPTS) break;
    const key = keys[t.provider];
    const base = PROVIDERS[t.provider].baseUrl(env);
    if (!key || !base) continue; // fournisseur non configuré

    const label = `${t.provider}/${t.model}`;
    const fp = await keyFingerprint(key);
    const pauseId = `${label}/${fp}`;
    const providerPauseId = `${t.provider}/*/${fp}`; // pause de tout le fournisseur pour cette clé
    const wait = Math.max(await cooldowns.remainingMs(providerPauseId), await cooldowns.remainingMs(pauseId));
    if (wait > 0) {
      attempts.push({ target: label, result: "en pause" });
      soonestMs = Math.min(soonestMs, wait);
      continue;
    }

    tries++;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
    let res: Response;
    try {
      const monModele = t.provider === "rdc";
      res = await fetch(monModele ? `${base}/run/${t.model}` : `${base}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify(monModele ? requeteMonModele(env, body) : { ...body, model: t.model }),
        signal: ctrl.signal,
      });
      if (monModele && res.ok) res = await convertirReponse(res, label);
    } catch (e) {
      attempts.push({ target: label, result: "erreur réseau", detail: String(e).slice(0, 200) });
      await cooldowns.coolDown(pauseId, 30_000);
      soonestMs = Math.min(soonestMs, 30_000);
      continue;
    } finally {
      clearTimeout(timer); // le flux (streaming) peut ensuite durer plus longtemps
    }

    if (res.ok) {
      // Succès : on renvoie le corps tel quel (streaming SSE compris).
      return new Response(res.body, {
        status: res.status,
        headers: {
          "content-type": res.headers.get("content-type") ?? "application/json",
          "cache-control": "no-store",
          "x-routed-to": label,
          "x-task": task,
        },
      });
    }

    const detail = (await res.text().catch(() => "")).slice(0, 300);
    attempts.push({ target: label, result: res.status, detail });

    let pauseMs = 0;
    if (res.status === 429 || res.status === 402) pauseMs = parseRetryMs(res.headers); // quota épuisé
    else if (res.status === 401 || res.status === 403) pauseMs = 3_600_000; // clé invalide
    else if (res.status >= 500) pauseMs = 30_000; // panne passagère
    // 400/404/413/422 : souvent propre au modèle (contexte trop long, image refusée) -> modèle suivant sans pause

    if (pauseMs > 0) {
      // Quota journalier ou de compte : inutile d'essayer les autres modèles de ce fournisseur.
      const providerWide =
        res.status === 401 ||
        res.status === 403 ||
        ((res.status === 429 || res.status === 402) &&
          (pauseMs >= PROVIDER_WIDE_PAUSE_MS || /per[- ]?day|daily/i.test(detail)));
      if (providerWide && pauseMs < PROVIDER_WIDE_PAUSE_MS && res.status !== 401 && res.status !== 403) {
        pauseMs = PROVIDER_WIDE_PAUSE_MS; // reset inconnu mais limite journalière : on attend au moins 10 min
      }
      await cooldowns.coolDown(providerWide ? providerPauseId : pauseId, pauseMs);
      soonestMs = Math.min(soonestMs, pauseMs);
    }
  }

  if (attempts.length === 0) {
    return json(503, {
      error: {
        message: "Aucun fournisseur configuré pour cette tâche.",
        type: "no_provider_configured",
        task,
      },
    });
  }

  const retryAfter = Number.isFinite(soonestMs) ? Math.ceil(soonestMs / 1000) : 60;
  return json(
    503,
    {
      error: {
        message: "Aucun modèle disponible pour le moment : quotas épuisés ou fournisseurs en erreur.",
        type: "all_providers_unavailable",
        task,
        attempts,
      },
    },
    { "retry-after": String(retryAfter) },
  );
}
