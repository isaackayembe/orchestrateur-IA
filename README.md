# Orchestrateur IA multi-modèles

Une passerelle unique, compatible avec l'API OpenAI, que vos extensions appellent en arrière-plan.
Pour chaque requête, elle :

1. devine le type de tâche (chat, code, long contexte, vision, résumé) ;
2. choisit le premier modèle disponible dans la liste de cette tâche ;
3. bascule automatiquement vers le modèle suivant si le fournisseur répond 429 (quota épuisé), 5xx ou ne répond pas ;
4. met le modèle refusé en pause jusqu'à l'heure de reset — ou **tout le fournisseur** quand c'est un quota journalier.

Elle tourne sur **Cloudflare Workers** (offre gratuite) et fournit une extension Chrome/Edge prête à l'emploi.

## Le parcours de l'utilisateur

| Étape | Ce que fait l'utilisateur | Effort | Capacité |
|---|---|---|---|
| 1. Essai | Il installe l'extension, c'est tout | 0 clic | Vos clés serveur, 20 requêtes/jour (réglable) |
| 2. OpenRouter | Il clique « Se connecter avec OpenRouter » | 1 clic, ~30 s | Son propre quota, plusieurs modèles gratuits |
| 3. Plus de capacité | Il colle une clé Gemini, Groq ou Mistral | 1–2 min par clé, facultatif | Beaucoup plus, avec bascule entre fournisseurs |

Quand l'essai est épuisé, l'orchestrateur renvoie une erreur `trial_limit_reached` avec
`action: "connect_openrouter"` : l'extension affiche alors la page d'options avec le bouton de connexion.

## Structure

| Fichier | Rôle |
|---|---|
| `src/index.ts` | Passerelle : routes HTTP, modes d'accès (essai, BYOK, admin), CORS, journal |
| `src/trial.ts` | Mode essai : compteurs par installation et par IP (D1, ou mémoire en repli) |
| `src/classify.ts` | Classifieur de tâches (règles simples, ou en-tête `X-Task`) |
| `src/router.ts` | Routeur et boucle de bascule, pause par modèle ou par fournisseur |
| `src/quota.ts` | Pauses de quota (mémoire + KV optionnel), lecture des en-têtes de reset |
| `src/config.ts` | **Fournisseurs et table de routage : le fichier à modifier** |
| `schema.sql` | Table D1 des compteurs d'essai |
| `src/savoir.ts` | Base de connaissances : domaines, recherche des fiches, apprentissage après chaque réponse |
| `src/admin.ts` | API du tableau de bord (fiches, images, domaines, export d'entraînement) |
| `src/monmodele.ts` | Branchement de **votre** modèle entraîné (LoRA sur Workers AI) |
| `schema-savoir.sql` | Tables D1 de la base de connaissances et des exemples d'entraînement |
| `public/admin/` | Tableau de bord administrateur, servi à `https://<votre-url>/admin/` |
| `ENTRAINEMENT.md` | **Guide : faire apprendre l'assistant et entraîner votre propre modèle** |
| `extension/` | Extension navigateur (Chrome, Edge) : page de chat, historique, paramètres |
| `vscode-extension/` | Extension VS Code / Cursor / VSCodium / Windsurf (voir son README) |
| `test/` | Tests : bascule, essai, OpenRouter seul, classifieur, quotas |

## 1. Déployer l'orchestrateur (gratuit)

Prérequis : Node.js 20+ et un compte Cloudflare gratuit.

```bash
npm install
npx wrangler login

# Base D1 pour compter l'essai gratuit (recommandé)
npx wrangler d1 create orchestrateur-essai
#   -> collez le database_id dans wrangler.toml et décommentez le bloc [[d1_databases]]
npx wrangler d1 execute orchestrateur-essai --remote --file=schema.sql

# Clés du serveur, utilisées uniquement pour l'essai (au moins une)
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put GROQ_API_KEY

# Votre clé administrateur : aucune limite pour vous (voir « Accès administrateur »)
npx wrangler secret put ADMIN_KEYS

npm run deploy
```

Vous obtenez une URL du type `https://orchestrateur-ia.<sous-domaine>.workers.dev`.
Vérifiez avec `GET /health` : `"trialStore": "d1"` confirme que les compteurs sont partagés.

Réglages dans `wrangler.toml` → `[vars]` : `TRIAL_DAILY_LIMIT` (par installation),
`TRIAL_IP_DAILY_LIMIT` (par adresse IP, contre ceux qui réinstallent pour remettre le compteur à zéro),
`ALLOW_TRIAL` et `ALLOW_BYOK`. Une tâche planifiée quotidienne (gratuite) efface les vieux compteurs.

Test local : copiez `.dev.vars.example` en `.dev.vars`, remplissez-le, puis `npm run dev`.

## 2. Installer l'extension navigateur

1. Dans `extension/config.js` **et** `extension/manifest.json`, remplacez
   `orchestrateur-ia.VOTRE-SOUS-DOMAINE.workers.dev` par votre URL.
2. Ouvrez `chrome://extensions` (ou `edge://extensions`), activez le mode développeur,
   cliquez « Charger l'extension non empaquetée » et choisissez le dossier `extension/`.
3. La page de l'assistant s'ouvre : le mode essai fonctionne déjà. Ensuite, un clic sur l'icône de
   l'extension la rouvre.

La page (`index.html`) est volontairement simple :

- **une barre de recherche** au centre ; après la première question, la conversation s'affiche
  et la barre descend en bas ; les réponses arrivent en flux et le bouton ■ les arrête ;
- **l'historique** des conversations à gauche (regroupé par date, avec recherche et suppression) ;
- sur la barre, le **bouton d'état** (« Essai · 12 » ou « Connecté ») : c'est le seul accès aux
  paramètres (connexion OpenRouter, clés facultatives), qui s'ouvrent dans une fenêtre par-dessus.

L'historique est conservé dans le navigateur (`chrome.storage.local`, 100 conversations au plus).

Pour utiliser l'IA depuis un autre script de l'extension (popup, content script) :

```js
const r = await chrome.runtime.sendMessage({
  type: "ia",
  messages: [{ role: "user", content: "Résume cette page : ..." }],
  tache: "summary", // facultatif
});
if (r.ok) console.log(r.texte, "via", r.modele);
else if (r.action === "connect_openrouter") chrome.runtime.sendMessage({ type: "ouvrirParametres" });
else console.warn(r.erreur);
```

### À vérifier avant publication : la connexion OpenRouter

Les paramètres utilisent l'OAuth PKCE d'OpenRouter avec `chrome.identity.launchWebAuthFlow`.
L'adresse de retour est `https://<id-de-l-extension>.chromiumapp.org/openrouter`. Testez la connexion
une fois l'extension chargée. Si OpenRouter refusait cette adresse, les paramètres proposent déjà la solution de
secours : coller une clé OpenRouter dans « Plus de capacité ». (L'extension VS Code, elle, utilise un retour
sur `localhost`, que la documentation d'OpenRouter accepte explicitement.) Pour publier sur le Chrome Web Store,
gardez un identifiant d'extension fixe (champ `key` du manifeste) afin que cette adresse ne change pas.

Firefox n'est pas couvert par cet exemple (son API `identity` diffère).

## Base de connaissances qui s'enrichit toute seule

L'orchestrateur tient un **fichier de connaissances par domaine** (design UX/UI, comptabilité,
développement… et ceux que vous créez). À chaque question :

1. il reconnaît le domaine et donne à l'IA les **fiches validées** utiles, avec leurs **images
   d'exemple** (l'IA peut les afficher dans sa réponse) ;
2. après la réponse, si la personne a **accepté le partage** (bandeau à la première utilisation,
   modifiable dans les paramètres) ou si c'est vous, il garde l'échange **anonymisé** et en tire
   de nouvelles fiches, qui attendent votre **validation** dans le tableau de bord ;
3. les échanges gardés et notés 👍 / 👎 forment le jeu de données pour **entraîner votre propre
   modèle** (voir `ENTRAINEMENT.md`), qui peut ensuite être branché dans l'orchestrateur.

Mise en place :

```bash
npx wrangler d1 create orchestrateur-savoir
#   -> collez le database_id dans wrangler.toml et décommentez le bloc DB_SAVOIR
npx wrangler d1 execute orchestrateur-savoir --remote --file=schema-savoir.sql
npm run deploy
```

Ouvrez ensuite `https://<votre-url>/admin/` avec votre clé administrateur :

- **À valider** : fiches apprises des conversations, à relire, corriger, illustrer, puis valider ;
- **Fiches** : tout le contenu, par domaine, avec recherche, images et téléchargement du fichier `.md` ;
- **Ajouter une fiche** : vos propres méthodes et exemples, avec images (compressées automatiquement) ;
- **Domaines** : créer un domaine (agriculture, santé, droit…) et ses mots-clés de détection ;
- **Entraînement** : exemples collectés par modèle d'origine, avec la licence de chacun, et export `.jsonl`.

Réglages (`wrangler.toml` → `[vars]`) : `APPRENTISSAGE`, `TAUX_EXTRACTION` (part des
conversations utilisateurs analysées, car chaque analyse consomme un appel d'IA sur vos clés),
`VALIDATION_AUTO_ADMIN`, `SYSTEME_ENTRAINEMENT`.

## Accès administrateur (vous, sans limite)

Les utilisateurs ont l'essai limité ; vous, avec la clé administrateur, n'avez **aucune limite d'essai**.
Vos requêtes utilisent les clés du serveur **et** vos clés personnelles si vous en ajoutez (plus de capacité).

1. Générez une clé longue et secrète (16 caractères minimum) :
   ```bash
   node -e "console.log('admin_' + require('crypto').randomBytes(24).toString('hex'))"
   ```
2. Enregistrez-la sur le serveur : `npx wrangler secret put ADMIN_KEYS` (plusieurs clés : séparez-les par des virgules).
3. Collez-la dans vos outils :
   - **extension navigateur** : bouton d'état → Paramètres → « Accès administrateur » ;
   - **VS Code** : bouton d'état → « Accès administrateur » (ou commande *Assistant IA : Clé administrateur*) ;
   - **autres outils** : en-tête `Authorization: Bearer <votre clé>`.
4. Le bouton d'état affiche alors **Admin**. Vérification : `GET /v1/acces` répond `{"mode":"admin"}`.

Ne publiez jamais cette clé (pas dans le code d'une extension distribuée) : elle donne accès aux clés du serveur.
Votre seule limite reste celle des fournisseurs eux-mêmes (quotas gratuits de vos comptes).

## 3. VS Code et autres IDE

- **VS Code, Cursor, VSCodium, Windsurf** : extension prête dans `vscode-extension/` (chat avec
  historique, Expliquer/Corriger la sélection, insertion du code, connexion OpenRouter en 1 clic).
  Voir `vscode-extension/README.md`.
- **JetBrains (IntelliJ, PyCharm, WebStorm…), Neovim, etc.** : l'orchestrateur parle le format OpenAI,
  donc toute extension qui accepte un fournisseur « compatible OpenAI » l'utilise. Exemple avec
  l'extension *Continue* (disponible pour VS Code et JetBrains), dans son fichier de configuration :

  ```yaml
  models:
    - name: Orchestrateur IA
      provider: openai
      model: auto
      apiBase: https://<votre-url>/v1
      apiKey: VOTRE_CLE_ADMIN        # ou n'importe quoi si vous n'envoyez que vos clés ci-dessous
      requestOptions:
        headers:
          X-Provider-Keys: "openrouter=sk-or-...; gemini=AIza..."
  ```

  (Le format exact peut varier selon la version de l'extension utilisée.)

## Utilisation directe de l'API

```bash
# Essai (sans clé)
curl https://<votre-url>/v1/chat/completions \
  -H "X-Install-Id: 3f1c0b9e-1234-4abc-9def-0123456789ab" \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Bonjour"}]}'

# Avec ses propres clés
curl ... -H "X-Provider-Keys: openrouter=sk-or-...; gemini=AIza..."
```

- `"model": "auto"` : le routeur choisit ; `"model": "groq/openai/gpt-oss-120b"` : ce modèle d'abord.
- En-tête `X-Task: code` : impose le type de tâche. `"stream": true` fonctionne.
- En-têtes de réponse : `X-Routed-To` (modèle utilisé), `X-Access-Mode` (`trial`, `byok`, `admin`),
  `X-Trial-Remaining` (en mode essai).
- Tout épuisé : **503** avec `Retry-After`. Essai épuisé : **429** `trial_limit_reached`.

## Modifier le routage

Tout est dans `src/config.ts` → `ROUTES`. Chaque tâche est une liste ordonnée de `{ provider, model }`.
Chaque liste contient plusieurs modèles OpenRouter gratuits pour que les utilisateurs « 1 clic » aient
aussi de la bascule. Les noms de modèles gratuits changent souvent : vérifiez-les régulièrement.

## Limites à connaître

- **Capacité de l'essai** : il consomme *vos* clés. Avec 20 requêtes par utilisateur, quelques dizaines
  d'essais simultanés suffisent à épuiser une clé gratuite ; ajustez `TRIAL_DAILY_LIMIT` à votre audience.
- **OpenRouter gratuit** : la limite journalière des modèles gratuits est faible pour un compte sans
  crédit acheté. Les gros utilisateurs ajouteront Gemini ou Groq.
- **Conditions d'utilisation** : basculer entre fournisseurs différents est légitime. Créer plusieurs comptes
  chez un même fournisseur pour cumuler les quotas gratuits enfreint généralement leurs conditions.
  Certaines offres gratuites sont réservées au développement : lisez-les avant de servir le public.
- **Confidentialité** : certaines offres gratuites (par exemple Gemini) peuvent utiliser les requêtes pour
  améliorer leurs produits. Dites-le à vos utilisateurs, surtout en mode essai où ce sont vos clés.
- **Clés dans le navigateur** : elles sont stockées dans `chrome.storage.local`, non chiffré. L'orchestrateur
  ne les enregistre pas (il ne garde qu'une empreinte courte pour gérer les pauses).
- **Sans D1** : les compteurs d'essai sont en mémoire, propres à chaque instance — limite approximative.
- **Bascule et streaming** : la bascule a lieu avant le début de la réponse ; un flux coupé en cours de
  route doit être relancé par l'extension.
- **Consentement et données** : rien n'est gardé d'une conversation sans l'accord de la personne (ou si
  ce n'est pas vous). L'anonymisation automatique masque courriels, numéros et clés, mais pas les noms :
  relisez les fiches et l'export. Informez vos utilisateurs dans une politique de confidentialité, et
  vérifiez les règles de protection des données qui s'appliquent à vous.
- **Sauvegarde** : une base D1 contenant un index plein texte (FTS5) ne peut pas être exportée avec
  `wrangler d1 export`. Sauvegardez avec le tableau de bord (fichiers `.md` et export `.jsonl`).
- **Offre gratuite de Workers** : le temps de calcul par requête est limité. Le serveur est
  conçu pour rester léger (export par pages de 500), mais un très gros usage peut demander l'offre payante.
