// Adresse de votre orchestrateur déployé (la même que dans manifest.json → host_permissions).
export const ORCHESTRATEUR_URL = "http://127.0.0.1:8787"; // local (npm run dev) — remplacez par l'adresse workers.dev après le déploiement

// Fournisseurs que l'utilisateur peut ajouter lui-même (section « Plus de capacité »).
// OpenRouter est en dernier : c'est la solution de secours si la connexion en 1 clic échoue.
export const FOURNISSEURS = {
  gemini: { nom: "Google Gemini", console: "https://aistudio.google.com/apikey" },
  groq: { nom: "Groq", console: "https://console.groq.com/keys" },
  mistral: { nom: "Mistral", console: "https://console.mistral.ai/api-keys" },
  openrouter: { nom: "OpenRouter", console: "https://openrouter.ai/keys" },
};
