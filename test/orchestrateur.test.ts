import { beforeEach, describe, expect, it, vi } from "vitest";
import { handle } from "../src/index";
import { classify } from "../src/classify";
import { parseDuration, parseRetryMs, resetCooldowns } from "../src/quota";
import { resetTrialMemory } from "../src/trial";
import type { Env } from "../src/config";

const env: Env = { GROQ_API_KEY: "srv_groq", GEMINI_API_KEY: "srv_gemini", CLIENT_KEYS: "admin_cle_test_0123456789", ALLOW_BYOK: "true" };

function chat(content: string, headers: Record<string, string> = { authorization: "Bearer admin_cle_test_0123456789" }) {
  return new Request("https://orchestrateur.test/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ model: "auto", messages: [{ role: "user", content }] }),
  });
}

const ok = (model: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content: `ok ${model}` } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  resetCooldowns();
  resetTrialMemory();
  vi.unstubAllGlobals();
});

const INSTALL = "inst-0123456789abcdef";
const trialEnv: Env = { GEMINI_API_KEY: "srv_gemini", ALLOW_TRIAL: "true", ALLOW_BYOK: "true", TRIAL_DAILY_LIMIT: "2" };

describe("mode essai", () => {
  it("autorise N requêtes sans clé puis demande de connecter OpenRouter", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => ok(JSON.parse(String(init.body)).model)));
    const h = { "x-install-id": INSTALL, "cf-connecting-ip": "203.0.113.7" };

    const r1 = await handle(chat("Bonjour", h), trialEnv);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("x-access-mode")).toBe("trial");
    expect(r1.headers.get("x-trial-remaining")).toBe("1");

    const r2 = await handle(chat("Bonjour", h), trialEnv);
    expect(r2.headers.get("x-trial-remaining")).toBe("0");

    const r3 = await handle(chat("Bonjour", h), trialEnv);
    expect(r3.status).toBe(429);
    const data = (await r3.json()) as { error: { type: string; action: string } };
    expect(data.error.type).toBe("trial_limit_reached");
    expect(data.error.action).toBe("connect_openrouter");
  });

  it("limite aussi par adresse IP (changer d'identifiant ne suffit pas)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok("x")));
    const env: Env = { ...trialEnv, TRIAL_DAILY_LIMIT: "10", TRIAL_IP_DAILY_LIMIT: "2" };
    const ip = { "cf-connecting-ip": "198.51.100.9" };
    expect((await handle(chat("a", { ...ip, "x-install-id": "aaaaaaaaaaaaaaaa1" }), env)).status).toBe(200);
    expect((await handle(chat("b", { ...ip, "x-install-id": "aaaaaaaaaaaaaaaa2" }), env)).status).toBe(200);
    expect((await handle(chat("c", { ...ip, "x-install-id": "aaaaaaaaaaaaaaaa3" }), env)).status).toBe(429);
  });

  it("refuse sans clé ni identifiant d'installation", async () => {
    const r = await handle(chat("Bonjour", {}), trialEnv);
    expect(r.status).toBe(401);
    const data = (await r.json()) as { error: { action: string } };
    expect(data.error.action).toBe("connect_openrouter");
  });

  it("les clés de l'utilisateur passent avant l'essai et ne consomment pas son quota", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok("x")));
    const h = { "x-install-id": INSTALL, "x-provider-keys": "openrouter=sk-or-user" };
    for (let i = 0; i < 5; i++) {
      const r = await handle(chat("Bonjour", h), trialEnv);
      expect(r.headers.get("x-access-mode")).toBe("byok");
    }
  });
});

describe("administrateur", () => {
  const ADMIN = "admin_cle_test_0123456789";
  const adminEnv: Env = { ...trialEnv, ADMIN_KEYS: ADMIN, TRIAL_DAILY_LIMIT: "1" };

  it("aucune limite d'essai pour l'administrateur", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ok("x")));
    for (let i = 0; i < 10; i++) {
      const r = await handle(chat("Bonjour", { authorization: `Bearer ${ADMIN}`, "x-install-id": INSTALL }), adminEnv);
      expect(r.status).toBe(200);
      expect(r.headers.get("x-access-mode")).toBe("admin");
      expect(r.headers.get("x-trial-remaining")).toBe(null);
    }
    // Les autres utilisateurs restent limités
    expect((await handle(chat("a", { "x-install-id": INSTALL }), adminEnv)).status).toBe(200);
    expect((await handle(chat("b", { "x-install-id": INSTALL }), adminEnv)).status).toBe(429);
  });

  it("combine les clés du serveur et les clés personnelles de l'administrateur", async () => {
    const auths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        auths.push(`${new URL(url).host} ${(init.headers as Record<string, string>).authorization}`);
        if (url.includes("generativelanguage")) return new Response("limite", { status: 429 });
        return ok("x");
      }),
    );
    const r = await handle(
      chat("Bonjour", { authorization: `Bearer ${ADMIN}`, "x-provider-keys": "openrouter=sk-or-admin" }),
      adminEnv,
    );
    expect(r.status).toBe(200);
    expect(auths).toEqual([
      "generativelanguage.googleapis.com Bearer srv_gemini",
      "generativelanguage.googleapis.com Bearer srv_gemini",
      "openrouter.ai Bearer sk-or-admin",
    ]);
  });

  it("GET /v1/acces reconnaît la clé admin ; une clé fausse ou trop courte est refusée", async () => {
    const acces = async (h: Record<string, string>, e: Env = adminEnv) =>
      ((await (await handle(new Request("https://o.test/v1/acces", { headers: h }), e)).json()) as { mode: string }).mode;
    expect(await acces({ authorization: `Bearer ${ADMIN}` })).toBe("admin");
    expect(await acces({ authorization: "Bearer mauvaise_cle_0123456789" })).toBe("public");
    expect(await acces({ authorization: "Bearer court" }, { ADMIN_KEYS: "court" })).toBe("public");
  });
});

describe("OpenRouter seul (connexion en 1 clic)", () => {
  const h = { "x-provider-keys": "openrouter=sk-or-user" };

  it("limite par minute sur un modèle : bascule vers un autre modèle OpenRouter", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init: RequestInit) => {
        const model = JSON.parse(String(init.body)).model as string;
        if (model.startsWith("meta-llama")) return new Response("busy", { status: 429, headers: { "retry-after": "10" } });
        return ok(model);
      }),
    );
    const r = await handle(chat("Bonjour", h), env);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-routed-to")).toBe("openrouter/deepseek/deepseek-chat-v3-0324:free");
  });

  it("limite journalière : pause de tout OpenRouter, sans brûler les autres modèles", async () => {
    let calls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        return new Response('{"error":{"message":"Rate limit exceeded: free-models-per-day"}}', {
          status: 429,
          headers: { "x-ratelimit-reset": String(Date.now() + 3 * 3600_000) },
        });
      }),
    );
    const r1 = await handle(chat("Bonjour", h), env);
    expect(r1.status).toBe(503);
    expect(calls).toBe(1); // les autres modèles OpenRouter ne sont pas essayés
    expect(Number(r1.headers.get("retry-after"))).toBeGreaterThan(3600);

    await handle(chat("Encore", h), env);
    expect(calls).toBe(1); // toujours en pause : aucun appel
  });
});

describe("bascule", () => {
  it("passe de Groq à Gemini sur 429, puis évite Groq pendant la pause", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push(url);
        if (url.includes("groq")) return new Response("limite", { status: 429, headers: { "retry-after": "30" } });
        return ok(JSON.parse(String(init.body)).model);
      }),
    );

    const r1 = await handle(chat("Bonjour"), env);
    expect(r1.status).toBe(200);
    expect(r1.headers.get("x-routed-to")).toBe("gemini/gemini-flash-latest");

    const r2 = await handle(chat("Encore bonjour"), env);
    expect(r2.status).toBe(200);
    expect(calls.filter((u) => u.includes("groq"))).toHaveLength(1); // Groq en pause, pas rappelé
  });

  it("renvoie 503 avec Retry-After quand tous les modèles sont épuisés", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("limite", { status: 429, headers: { "retry-after": "120" } })));
    const r = await handle(chat("Bonjour"), env);
    expect(r.status).toBe(503);
    expect(Number(r.headers.get("retry-after"))).toBe(120);
    const data = (await r.json()) as { error: { attempts: unknown[] } };
    expect(data.error.attempts.length).toBeGreaterThan(0);
  });

  it("passe au modèle suivant sur erreur réseau", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        if (url.includes("groq")) throw new Error("ECONNRESET");
        return ok(JSON.parse(String(init.body)).model);
      }),
    );
    const r = await handle(chat("Bonjour"), env);
    expect(r.headers.get("x-routed-to")).toBe("gemini/gemini-flash-latest");
  });
});

describe("accès", () => {
  it("refuse une requête sans clé", async () => {
    const r = await handle(chat("Bonjour", {}), env);
    expect(r.status).toBe(401);
  });

  it("BYOK : utilise uniquement les clés de l'utilisateur", async () => {
    const auths: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        auths.push((init.headers as Record<string, string>).authorization);
        return ok("x");
      }),
    );
    const r = await handle(chat("Bonjour", { "x-provider-keys": "gemini=user_gemini" }), env);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-routed-to")).toBe("gemini/gemini-flash-latest");
    expect(auths).toEqual(["Bearer user_gemini"]);
  });

  it("un modèle forcé est essayé en premier", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => ok(JSON.parse(String(init.body)).model)));
    const req = new Request("https://orchestrateur.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin_cle_test_0123456789" },
      body: JSON.stringify({ model: "gemini/gemini-flash-lite-latest", messages: [{ role: "user", content: "Salut" }] }),
    });
    const r = await handle(req, env);
    expect(r.headers.get("x-routed-to")).toBe("gemini/gemini-flash-lite-latest");
  });
});

describe("votre modèle (LoRA sur Workers AI)", () => {
  const envRdc: Env = {
    ...env,
    CF_ACCOUNT_ID: "compte123",
    CF_API_TOKEN: "cf_token",
    MON_MODELE_LORA: "mon-modele-rdc",
  };
  const flux = (morceaux: string[]) => {
    const enc = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(c) {
          for (const m of morceaux) c.enqueue(enc.encode(`data: ${JSON.stringify({ response: m })}\n\n`));
          c.enqueue(enc.encode("data: [DONE]\n\n"));
          c.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  };

  it("passe en premier pour le chat, avec conversion du flux au format OpenAI", async () => {
    const appels: { url: string; body: any }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        appels.push({ url, body: JSON.parse(String(init.body)) });
        return flux(["Mbote", " ! Na", "lingi ko sunga yo."]);
      }),
    );
    const req = new Request("https://o.test/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer admin_cle_test_0123456789" },
      body: JSON.stringify({ model: "auto", stream: true, messages: [{ role: "user", content: "Mbote" }] }),
    });
    const r = await handle(req, envRdc);
    expect(r.headers.get("x-routed-to")).toBe("rdc/@cf/mistral/mistral-7b-instruct-v0.2-lora");
    expect(appels[0].url).toBe("https://api.cloudflare.com/client/v4/accounts/compte123/ai/run/@cf/mistral/mistral-7b-instruct-v0.2-lora");
    expect(appels[0].body.lora).toBe("mon-modele-rdc");
    const texte = (await r.text())
      .split("\n")
      .filter((l) => l.startsWith("data: {"))
      .map((l) => JSON.parse(l.slice(6)).choices[0].delta.content)
      .join("");
    expect(texte).toBe("Mbote ! Nalingi ko sunga yo.");
  });

  it("bascule vers les autres modèles si votre modèle échoue, et n'est pas utilisé pour le code", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        urls.push(url);
        if (url.includes("/ai/run/")) return new Response("indisponible", { status: 503 });
        return ok(JSON.parse(String(init.body)).model);
      }),
    );
    const r1 = await handle(chat("Bonjour"), envRdc);
    expect(r1.headers.get("x-routed-to")).toBe("groq/openai/gpt-oss-120b");
    expect(urls[0].includes("/ai/run/")).toBe(true);

    urls.length = 0;
    resetCooldowns();
    await handle(chat("Corrige ce bug dans ma fonction"), envRdc);
    expect(urls.some((u) => u.includes("/ai/run/"))).toBe(false);
  });
});

describe("classifieur", () => {
  it("reconnaît les tâches", () => {
    expect(classify([{ role: "user", content: "Corrige ce bug dans ma fonction" }])).toBe("code");
    expect(classify([{ role: "user", content: "Résume cet article" }])).toBe("summary");
    expect(classify([{ role: "user", content: [{ type: "image_url" }, { type: "text", text: "Que vois-tu ?" }] }])).toBe("vision");
    expect(classify([{ role: "user", content: "x".repeat(40_000) }])).toBe("long");
    expect(classify([{ role: "user", content: "Quelle heure est-il à Kinshasa ?" }])).toBe("chat");
    expect(classify([{ role: "user", content: "Bonjour" }], "code")).toBe("code");
  });
});

describe("quotas", () => {
  it("lit les durées de reset", () => {
    expect(parseDuration("2m59.56s")).toBe(179_560);
    expect(parseDuration("250ms")).toBe(250);
    expect(parseRetryMs(new Headers({ "retry-after": "45" }))).toBe(45_000);
    expect(parseRetryMs(new Headers({ "x-ratelimit-reset-requests": "1m30s" }))).toBe(90_000);
    expect(parseRetryMs(new Headers())).toBe(60_000);
  });
});
