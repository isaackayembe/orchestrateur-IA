# Assistant IA pour VS Code

Le chat de l'orchestrateur directement dans l'éditeur. Fonctionne aussi dans les éditeurs basés sur VS Code :
**Cursor, VSCodium, Windsurf**.

- Vue « Chat » dans la barre latérale, avec **historique** des conversations (☰) et recherche.
- **📎 Fichier actif** : joint la sélection (ou le fichier entier) à votre question.
- Clic droit sur une sélection → **Expliquer la sélection** / **Corriger et améliorer la sélection**
  (raccourcis : `Ctrl+Alt+I` ouvre le chat, `Ctrl+Alt+E` explique la sélection).
- Sur chaque bloc de code de la réponse : **Insérer** (remplace la sélection ou insère au curseur) et **Copier**.
- Bouton d'état **Connecté / Essai** dans la barre : ouvre les paramètres.
  - **Se connecter avec OpenRouter** : 1 clic, le navigateur s'ouvre, la clé revient toute seule
    (retour sur `http://localhost:<port>`, accepté par OpenRouter).
  - **Ajouter une clé** Gemini, Groq, Mistral : testée avant d'être enregistrée.
- Les clés sont dans le **coffre sécurisé** de l'éditeur (SecretStorage), jamais dans la vue ni dans les réglages.

## Installer

Prérequis : Node.js 20+.

```bash
cd vscode-extension
npx @vscode/vsce package          # crée orchestrateur-ia-0.1.0.vsix
code --install-extension orchestrateur-ia-0.1.0.vsix
```

Ou dans l'éditeur : Extensions → « … » → *Installer à partir d'un VSIX*.
Pour tester sans empaqueter : ouvrez ce dossier dans VS Code et appuyez sur `F5`.

Puis réglez l'adresse de votre orchestrateur : Paramètres → `orchestrateurIA.url`.

**Administrateur** : cliquez sur le bouton d'état du chat → « Accès administrateur » et collez votre clé
`ADMIN_KEYS`. Le bouton affiche **Admin** : aucune limite d'essai.

Avant de publier sur le Marketplace (ou sur Open VSX pour Cursor et VSCodium), remplacez `publisher`
dans `package.json` par votre identifiant d'éditeur.

## Développement à distance

En SSH, conteneur ou Codespaces, l'extension utilise `asExternalUri` pour que la page de retour
OpenRouter atteigne l'éditeur. Si la connexion échoue malgré tout, choisissez « Coller une clé à la place ».
