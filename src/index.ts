// Passerelle : point d'entrée unique, compatible avec l'API OpenAI.
//   POST /v1/chat/completions   (model: "auto" ou "fournisseur/modèle")
//   GET  /v1/models
//   GET  /health
//
// Trois modes d'accès, du plus simple au plus puissant :
//   1. essai   : aucune clé, en-tête X-Install-Id ; clés du serveur, limite par jour
//   2. byok    : l'utilisateur envoie ses propres clés (X-Provider-Keys), dont la
//                clé OpenRouter obtenue en 1 clic par l'extension
//   3. admin   : clé administrateur (ADMIN_KEYS) : aucune limite d'essai, clés du serveur + les siennes

import { ROUTES } from "./config";
import type { Env } from "./config";
import { classify, textOf } from "./classify";
import type { Msg } from "./classify";
import { routeAdmin, servirImage } from "./admin";
import { apprendre, chercherFiches, detecterDomaine, domaines, injecter, lireTexte, messageConnaissances } from "./savoir";
import { Cooldowns } from "./quota";
import { json, parseByok, routeChat, serverKeys } from "./router";
import type { KeySet } from "./router";
import { INSTALL_ID_RE, consumeTrial, secondsUntilUtcMidnight, today, trialStore } from "./trial";

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-task, x-provider-keys, x-install-id, x-partage, x-domaine",
  "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "access-control-expose-headers":
    "x-routed-to, x-task, x-access-mode, x-trial-remaining, x-connaissances, x-echantillon-id, retry-after",
};

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const res = await handle(req, env, ctx);
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
    return out;
  },

  // Tâche planifiée quotidienne (gratuite) : supprime les vieux compteurs d'essai.
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const twoDaysAgo = today(new Date(Date.now() - 2 * 86_400_000));
    await trialStore(env).purgeBefore(twoDaysAgo);
  },
};

type Access =
  | { mode: "byok" | "admin"; keys: KeySet }
  | { mode: "trial"; keys: KeySet; installId: string }
  | { mode: "denied"; response: Response };

/** Comparaison en temps constant (évite de deviner la clé admin caractère par caractère). */
function egal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function isAdmin(req: Request, env: Env): boolean {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  return `${env.ADMIN_KEYS ?? ""},${env.CLIENT_KEYS ?? ""}`
    .split(",")
    .map((s) => s.trim())
    .filter((k) => k.length >= 16) // refuse les clés trop courtes
    .some((k) => egal(k, token));
}

function resolveAccess(req: Request, env: Env): Access {
  const byok = env.ALLOW_BYOK === "true" ? parseByok(req.headers.get("x-provider-keys")) : {};

  // 1) Administrateur : aucune limite d'essai ; clés du serveur + ses propres clés éventuelles.
  if (isAdmin(req, env)) return { mode: "admin", keys: { ...serverKeys(env), ...byok } };

  // 2) Clés de l'utilisateur : n'utilisent jamais celles du serveur.
  if (Object.keys(byok).length > 0) return { mode: "byok", keys: byok };

  // 3) Essai sans clé.
  const installId = req.headers.get("x-install-id") ?? "";
  if (env.ALLOW_TRIAL === "true" && INSTALL_ID_RE.test(installId)) {
    return { mode: "trial", keys: serverKeys(env), installId };
  }

  return {
    mode: "denied",
    response: json(401, {
      error: {
        message: "Aucune clé fournie. Connectez votre compte OpenRouter dans les options de l'extension.",
        type: "unauthorized",
        action: "connect_openrouter",
      },
    }),
  };
}

export async function handle(req: Request, env: Env, ctx?: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") return new Response(null, { status: 204 });

  // Images d'exemple de la base de connaissances (publiques, adresses impossibles à deviner)
  if (req.method === "GET" && url.pathname.startsWith("/images/")) {
    return servirImage(env, url.pathname.slice("/images/".length));
  }

  // API du tableau de bord : réservée à l'administrateur
  if (url.pathname.startsWith("/admin/api/")) {
    if (!isAdmin(req, env)) return json(401, { error: { message: "Clé administrateur requise.", type: "unauthorized" } });
    return routeAdmin(req, env, url);
  }

  // Avis 👍 / 👎 sur une réponse (améliore le tri des données d'entraînement)
  if (req.method === "POST" && url.pathname === "/v1/avis") {
    const b = (await req.json().catch(() => null)) as { id?: unknown; note?: unknown } | null;
    const note = b?.note === 1 || b?.note === -1 || b?.note === 0 ? b.note : null;
    if (typeof b?.id !== "string" || note === null) return json(400, { error: { message: "id et note (1, 0 ou -1) requis." } });
    if (env.DB_SAVOIR) await env.DB_SAVOIR.prepare("UPDATE echantillons SET note = ?1 WHERE id = ?2").bind(note, b.id).run();
    return json(200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/health") {
    return json(200, {
      ok: true,
      providers: Object.keys(serverKeys(env)),
      byok: env.ALLOW_BYOK === "true",
      trial: env.ALLOW_TRIAL === "true",
      trialStore: env.TRIAL_DB ? "d1" : "memory",
      savoir: !!env.DB_SAVOIR,
      apprentissage: env.APPRENTISSAGE === "true",
    });
  }

  // Indique quel accès a l'appelant, sans rien consommer (sert à tester la clé admin).
  if (req.method === "GET" && url.pathname === "/v1/acces") {
    if (isAdmin(req, env)) return json(200, { mode: "admin", limite: null });
    return json(200, { mode: "public" });
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    const ids = new Set<string>(["auto"]);
    for (const list of Object.values(ROUTES)) for (const t of list) ids.add(`${t.provider}/${t.model}`);
    return json(200, {
      object: "list",
      data: [...ids].map((id) => ({ id, object: "model", owned_by: "orchestrateur" })),
    });
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    const access = resolveAccess(req, env);
    if (access.mode === "denied") return access.response;

    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json(400, { error: { message: "Corps JSON invalide.", type: "invalid_request" } });
    }
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
      return json(400, { error: { message: "Le champ 'messages' est requis.", type: "invalid_request" } });
    }

    let trialRemaining: number | null = null;
    if (access.mode === "trial") {
      const trial = await consumeTrial(env, access.installId, req.headers.get("cf-connecting-ip"));
      if (!trial.allowed) {
        return json(
          429,
          {
            error: {
              message:
                trial.reason === "unavailable"
                  ? "L'essai gratuit est momentanément indisponible. Connectez votre compte OpenRouter pour continuer."
                  : `Essai gratuit épuisé pour aujourd'hui (${trial.limit} requêtes). Connectez votre compte OpenRouter en 1 clic pour continuer.`,
              type: "trial_limit_reached",
              action: "connect_openrouter",
            },
          },
          { "retry-after": String(secondsUntilUtcMidnight()), "x-access-mode": "trial", "x-trial-remaining": "0" },
        );
      }
      trialRemaining = trial.remaining;
    }

    const messages = body.messages as Msg[];
    const task = classify(messages, req.headers.get("x-task"));
    const started = Date.now();

    // Base de connaissances : on donne à l'IA les fiches validées qui correspondent à la question.
    let savoir: { domaine: string; fiches: number } | null = null;
    let corpsEnvoye = body;
    if (env.DB_SAVOIR) {
      try {
        const domaine = detecterDomaine(await domaines(env.DB_SAVOIR), messages, req.headers.get("x-domaine"));
        const question = textOf([...messages].reverse().find((m) => m.role === "user")?.content);
        const fiches = await chercherFiches(env.DB_SAVOIR, domaine, question);
        const texte = await messageConnaissances(env.DB_SAVOIR, fiches, url.origin);
        if (texte) corpsEnvoye = { ...body, messages: injecter(messages, texte) };
        savoir = { domaine, fiches: fiches.length };
      } catch (e) {
        console.log(JSON.stringify({ savoir: "indisponible", erreur: String(e).slice(0, 200) }));
      }
    }

    let res = await routeChat(corpsEnvoye, task, access.keys, env, new Cooldowns(env.QUOTA_KV));
    res.headers.set("x-access-mode", access.mode);
    if (trialRemaining !== null) res.headers.set("x-trial-remaining", String(trialRemaining));
    if (savoir) res.headers.set("x-connaissances", `${savoir.domaine};${savoir.fiches}`);

    // Apprentissage en arrière-plan : seulement avec consentement (ou pour l'administrateur).
    const consentement = access.mode === "admin" || req.headers.get("x-partage") === "oui";
    if (res.ok && res.body && savoir && ctx && env.APPRENTISSAGE === "true" && consentement) {
      const echantillonId = crypto.randomUUID();
      const taux = Math.min(1, Math.max(0, Number(env.TAUX_EXTRACTION ?? "0.3") || 0));
      const extraire = access.mode === "admin" || Math.random() < taux;
      const clesExtraction = Object.keys(serverKeys(env)).length ? serverKeys(env) : access.mode === "admin" ? access.keys : {};
      const appelerIA = async (m: Msg[]) => {
        const r = await routeChat({ messages: m, max_tokens: 700, temperature: 0.2 }, "summary", clesExtraction, env, new Cooldowns(env.QUOTA_KV));
        return r.ok && r.body ? lireTexte(r.body, r.headers.get("content-type") ?? "") : null;
      };
      const [versClient, copie] = res.body.tee();
      const modele = res.headers.get("x-routed-to");
      const contentType = res.headers.get("content-type") ?? "";
      ctx.waitUntil(
        lireTexte(copie, contentType)
          .then((texte) =>
            apprendre(env, { echantillonId, domaine: savoir!.domaine, messages, mode: access.mode, extraire }, texte, modele, appelerIA),
          )
          .catch((e) => console.log(JSON.stringify({ apprentissage: "échec", erreur: String(e).slice(0, 200) }))),
      );
      res = new Response(versClient, res);
      res.headers.set("x-echantillon-id", echantillonId);
    }

    // Journal (visible dans le tableau de bord Cloudflare) — sans contenu ni clé.
    console.log(
      JSON.stringify({
        mode: access.mode,
        task,
        routedTo: res.headers.get("x-routed-to"),
        status: res.status,
        ms: Date.now() - started,
        savoir,
      }),
    );
    return res;
  }

  return json(404, { error: { message: "Route inconnue.", type: "not_found" } });
}
