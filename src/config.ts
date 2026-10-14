// Configuration centrale : fournisseurs, table de routage et réglages.
// Les offres gratuites et les noms de modèles changent souvent :
// vérifiez-les dans la console de chaque fournisseur avant de déployer.

export type ProviderId = "groq" | "gemini" | "mistral" | "openrouter" | "cloudflare" | "rdc";
export type Task = "chat" | "code" | "long" | "vision" | "summary";

export interface Target {
  provider: ProviderId;
  model: string;
}

export interface Env {
  // Clés des fournisseurs (secrets Cloudflare, jamais dans le code des extensions)
  GROQ_API_KEY?: string;
  GEMINI_API_KEY?: string;
  MISTRAL_API_KEY?: string;
  OPENROUTER_API_KEY?: string;
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  // Clés administrateur (séparées par des virgules, 16 caractères minimum) :
  // aucune limite d'essai, accès aux clés du serveur. CLIENT_KEYS est l'ancien nom, toujours accepté.
  ADMIN_KEYS?: string;
  CLIENT_KEYS?: string;
  // "true" : chaque utilisateur peut fournir ses propres clés (BYOK)
  ALLOW_BYOK?: string;
  // "true" : essai sans clé, sur les clés du serveur, limité par jour
  ALLOW_TRIAL?: string;
  TRIAL_DAILY_LIMIT?: string; // requêtes d'essai par installation et par jour (défaut 20)
  TRIAL_IP_DAILY_LIMIT?: string; // requêtes d'essai par adresse IP et par jour (défaut 60)
  // Base D1 qui compte les requêtes d'essai (fortement recommandée en production)
  TRIAL_DB?: D1Database;
  // Optionnel : partage des pauses de quota entre toutes les instances
  QUOTA_KV?: KVNamespace;

  // Base de connaissances et données d'entraînement (voir schema-savoir.sql)
  DB_SAVOIR?: D1Database;
  APPRENTISSAGE?: string; // "true" : apprend des conversations (admin, ou utilisateurs qui ont accepté)
  TAUX_EXTRACTION?: string; // part des conversations utilisateurs analysées (0 à 1, défaut 0.3)
  VALIDATION_AUTO_ADMIN?: string; // "true" : les fiches tirées de vos conversations sont validées d'office
  SYSTEME_ENTRAINEMENT?: string; // message système placé en tête des exemples exportés

  // Votre modèle entraîné (adaptateur LoRA sur Workers AI) — voir ENTRAINEMENT.md
  MON_MODELE_LORA?: string; // nom ou identifiant de l'adaptateur (wrangler ai finetune create …)
  MON_MODELE_BASE?: string; // modèle de base compatible LoRA (défaut : @cf/mistral/mistral-7b-instruct-v0.2-lora)
  MON_MODELE_TACHES?: string; // tâches où il passe en premier, ex. "chat,summary" (défaut)
  MON_MODELE_RAW?: string; // "true" : n'applique pas le modèle de conversation par défaut
}

// Ce que les licences permettent pour entraîner VOTRE modèle sur les réponses d'un modèle.
// Indicatif, à vérifier vous-même dans chaque licence (ce n'est pas un avis juridique).
// L'export « autorisé » du tableau de bord ne garde que les statuts "autorise".
export type StatutLicence = "autorise" | "a_verifier" | "interdit";
export const POLITIQUE_ENTRAINEMENT: { motif: RegExp; statut: StatutLicence; note: string }[] = [
  {
    motif: /^rdc\//,
    statut: "autorise",
    note: "Votre propre modèle (vérifiez la licence de son modèle de base).",
  },
  {
    motif: /^gemini\//,
    statut: "interdit",
    note: "Conditions de l'API Gemini : interdit d'utiliser le service pour développer des modèles concurrents.",
  },
  {
    motif: /gemma/i,
    statut: "a_verifier",
    note: "Conditions Gemma : un modèle entraîné sur ses réponses peut être considéré comme un dérivé soumis à ces conditions.",
  },
  {
    motif: /llama/i,
    statut: "autorise",
    note: "Licence Llama : autorisé sous conditions (mention « Llama » dans le nom du modèle distribué, attribution).",
  },
  {
    motif: /qwen|gpt-oss|deepseek/i,
    statut: "autorise",
    note: "Licences ouvertes (Apache 2.0 ou MIT) : vérifiez la licence de la version exacte utilisée.",
  },
  {
    motif: /^mistral\//,
    statut: "a_verifier",
    note: "Vérifiez les conditions de l'offre Mistral utilisée avant d'entraîner un modèle sur ses réponses.",
  },
];

export function statutLicence(modele: string | null | undefined): { statut: StatutLicence; note: string } {
  if (!modele) return { statut: "a_verifier", note: "Modèle inconnu." };
  const regle = POLITIQUE_ENTRAINEMENT.find((r) => r.motif.test(modele));
  return regle ?? { statut: "a_verifier", note: "Aucune règle connue pour ce modèle : vérifiez sa licence." };
}

// Tous ces fournisseurs exposent une API compatible OpenAI :
// l'adaptateur se résume donc à une URL de base et une clé.
export const PROVIDERS: Record<
  ProviderId,
  { keyEnv: keyof Env; byok: boolean; baseUrl: (env: Env) => string | null }
> = {
  groq: { keyEnv: "GROQ_API_KEY", byok: true, baseUrl: () => "https://api.groq.com/openai/v1" },
  gemini: {
    keyEnv: "GEMINI_API_KEY",
    byok: true,
    baseUrl: () => "https://generativelanguage.googleapis.com/v1beta/openai",
  },
  mistral: { keyEnv: "MISTRAL_API_KEY", byok: true, baseUrl: () => "https://api.mistral.ai/v1" },
  openrouter: { keyEnv: "OPENROUTER_API_KEY", byok: true, baseUrl: () => "https://openrouter.ai/api/v1" },
  cloudflare: {
    keyEnv: "CF_API_TOKEN",
    byok: false,
    baseUrl: (env) =>
      env.CF_ACCOUNT_ID ? `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1` : null,
  },
  // VOTRE modèle : un adaptateur LoRA entraîné sur vos données, servi par Workers AI (voir ENTRAINEMENT.md).
  // N'est utilisé que si MON_MODELE_LORA est défini. Format d'API propre à Workers AI (converti dans monmodele.ts).
  rdc: {
    keyEnv: "CF_API_TOKEN",
    byok: false,
    baseUrl: (env) =>
      env.CF_ACCOUNT_ID && env.MON_MODELE_LORA ? `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai` : null,
  },
};

// Pour chaque type de tâche : liste ordonnée. Le routeur prend le premier
// modèle disponible (clé présente, pas en pause), puis descend la liste.
// Chaque liste contient plusieurs modèles OpenRouter gratuits : un utilisateur
// qui n'a connecté qu'OpenRouter (1 clic) bénéficie quand même de la bascule.
const OR_LLAMA = { provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct:free" } as const;
const OR_DEEPSEEK = { provider: "openrouter", model: "deepseek/deepseek-chat-v3-0324:free" } as const;
const OR_GEMMA = { provider: "openrouter", model: "google/gemma-3-27b-it:free" } as const; // texte + images
const OR_QWEN_CODER = { provider: "openrouter", model: "qwen/qwen3-coder:free" } as const;

export const ROUTES: Record<Task, Target[]> = {
  chat: [
    { provider: "groq", model: "openai/gpt-oss-120b" },
    { provider: "gemini", model: "gemini-flash-latest" },
    { provider: "gemini", model: "gemini-flash-lite-latest" },
    { provider: "mistral", model: "mistral-small-latest" },
    OR_LLAMA,
    OR_DEEPSEEK,
    OR_GEMMA,
    { provider: "cloudflare", model: "@cf/meta/llama-3.1-8b-instruct" },
  ],
  code: [
    OR_QWEN_CODER,
    { provider: "groq", model: "openai/gpt-oss-120b" },
    { provider: "gemini", model: "gemini-flash-latest" },
    { provider: "gemini", model: "gemini-flash-lite-latest" },
    { provider: "mistral", model: "mistral-small-latest" },
    OR_DEEPSEEK,
    OR_LLAMA,
  ],
  long: [
    { provider: "gemini", model: "gemini-flash-latest" },
    { provider: "gemini", model: "gemini-flash-lite-latest" },
    { provider: "mistral", model: "mistral-small-latest" },
    OR_LLAMA,
    OR_DEEPSEEK,
  ],
  vision: [
    { provider: "gemini", model: "gemini-flash-latest" },
    { provider: "mistral", model: "mistral-small-latest" },
    OR_GEMMA,
  ],
  summary: [
    { provider: "mistral", model: "mistral-small-latest" },
    { provider: "gemini", model: "gemini-flash-lite-latest" },
    { provider: "groq", model: "openai/gpt-oss-20b" },
    OR_GEMMA,
    OR_LLAMA,
    { provider: "cloudflare", model: "@cf/meta/llama-3.1-8b-instruct" },
  ],
};

// Une pause d'au moins cette durée signifie un quota journalier ou de compte
// (ex. 50 requêtes/jour sur les modèles gratuits OpenRouter) : on met alors en
// pause TOUT le fournisseur pour cette clé, pas seulement le modèle.
export const PROVIDER_WIDE_PAUSE_MS = 10 * 60_000;

export const MAX_ATTEMPTS = 4; // tentatives maximum par requête
export const UPSTREAM_TIMEOUT_MS = 30_000; // délai pour recevoir les en-têtes du fournisseur
