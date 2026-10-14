// Classifieur : devine le type de tâche à partir des messages.
// Règles simples et gratuites ; l'extension peut aussi imposer la tâche
// avec l'en-tête X-Task (chat, code, long, vision, summary).

import type { Task } from "./config";

const TASKS: Task[] = ["chat", "code", "long", "vision", "summary"];

export interface Msg {
  role?: string;
  content?: unknown;
}

type Part = { type?: unknown; text?: unknown };

function parts(content: unknown): Part[] {
  return Array.isArray(content) ? content.filter((p): p is Part => !!p && typeof p === "object") : [];
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  return parts(content)
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join(" ");
}

function hasImage(content: unknown): boolean {
  return parts(content).some((p) => p.type === "image_url" || p.type === "input_image");
}

const CODE_RE =
  /```|\b(function|def|class|const|import|select|traceback|exception|stack trace)\b|\b(code|bug|refactor|debug|compil)/;
const SUMMARY_RE = /\b(résume|résumé|resume|summar|tradui|traduction|translate)/;

export function classify(messages: Msg[], hint?: string | null): Task {
  if (hint && TASKS.includes(hint as Task)) return hint as Task;
  if (messages.some((m) => hasImage(m.content))) return "vision";
  const total = messages.reduce((n, m) => n + textOf(m.content).length, 0);
  if (total > 30_000) return "long";
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const text = textOf(lastUser?.content).toLowerCase();
  if (CODE_RE.test(text)) return "code";
  if (SUMMARY_RE.test(text)) return "summary";
  return "chat";
}
