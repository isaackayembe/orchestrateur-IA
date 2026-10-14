// Votre propre modèle : un adaptateur LoRA entraîné sur vos données et servi par Workers AI.
// Workers AI sert les LoRA via son API « run » (pas le format OpenAI) : on convertit dans les deux sens,
// pour que le reste de l'orchestrateur (bascule, flux, apprentissage) fonctionne sans changement.

import type { Env, Target, Task } from "./config";
import type { Msg } from "./classify";
import { textOf } from "./classify";

export const MODELE_BASE_DEFAUT = "@cf/mistral/mistral-7b-instruct-v0.2-lora";

/** Votre modèle, s'il est configuré et prévu pour cette tâche. */
export function cibleMonModele(env: Env, task: Task): Target | null {
  if (!env.MON_MODELE_LORA || !env.CF_ACCOUNT_ID) return null;
  const taches = (env.MON_MODELE_TACHES ?? "chat,summary").split(",").map((t) => t.trim());
  if (!taches.includes(task)) return null;
  return { provider: "rdc", model: env.MON_MODELE_BASE ?? MODELE_BASE_DEFAUT };
}

/** Requête au format Workers AI « run ». */
export function requeteMonModele(env: Env, body: Record<string, unknown>): Record<string, unknown> {
  const messages = (Array.isArray(body.messages) ? (body.messages as Msg[]) : []).map((m) => ({
    role: m.role ?? "user",
    content: textOf(m.content), // modèle texte : les images ne sont pas transmises
  }));
  const r: Record<string, unknown> = { messages, lora: env.MON_MODELE_LORA, stream: body.stream === true };
  if (typeof body.max_tokens === "number") r.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") r.temperature = body.temperature;
  if (env.MON_MODELE_RAW === "true") r.raw = true;
  return r;
}

/** Convertit une réponse Workers AI réussie au format OpenAI (JSON ou flux SSE). */
export async function convertirReponse(res: Response, modele: string): Promise<Response> {
  const enTetes = { "cache-control": "no-store" };
  if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = (await res.json().catch(() => null)) as { result?: { response?: string } } | null;
    return new Response(
      JSON.stringify({
        object: "chat.completion",
        model: modele,
        choices: [{ index: 0, message: { role: "assistant", content: data?.result?.response ?? "" }, finish_reason: "stop" }],
      }),
      { headers: { ...enTetes, "content-type": "application/json" } },
    );
  }

  // Flux : "data: {"response":"..."}" -> "data: {"choices":[{"delta":{"content":"..."}}]}"
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let tampon = "";
  const convertirLigne = (ligne: string, sortie: TransformStreamDefaultController<Uint8Array>) => {
    const l = ligne.trim();
    if (!l.startsWith("data:")) return;
    const d = l.slice(5).trim();
    if (d === "[DONE]") {
      sortie.enqueue(enc.encode("data: [DONE]\n\n"));
      return;
    }
    try {
      const morceau = JSON.parse(d)?.response;
      if (typeof morceau === "string" && morceau) {
        sortie.enqueue(enc.encode(`data: ${JSON.stringify({ object: "chat.completion.chunk", model: modele, choices: [{ index: 0, delta: { content: morceau } }] })}\n\n`));
      }
    } catch {
      // ligne incomplète : ignorée
    }
  };
  const transformation = new TransformStream<Uint8Array, Uint8Array>({
    transform(octets, sortie) {
      tampon += dec.decode(octets, { stream: true });
      let i;
      while ((i = tampon.indexOf("\n")) >= 0) {
        convertirLigne(tampon.slice(0, i), sortie);
        tampon = tampon.slice(i + 1);
      }
    },
    flush(sortie) {
      if (tampon) convertirLigne(tampon, sortie);
    },
  });
  return new Response(res.body!.pipeThrough(transformation), {
    headers: { ...enTetes, "content-type": "text/event-stream" },
  });
}
