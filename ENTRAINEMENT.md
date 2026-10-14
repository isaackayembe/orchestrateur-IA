# Faire apprendre l'assistant, puis entraîner votre propre modèle

L'orchestrateur apprend de deux façons, à deux vitesses.

| | Base de connaissances | Votre modèle entraîné |
|---|---|---|
| **Quand** | Immédiatement, à chaque fiche validée | De temps en temps (par exemple chaque mois) |
| **Comment** | Les fiches validées sont données à l'IA avec la question | Un adaptateur LoRA est entraîné sur vos exemples |
| **Coût** | Gratuit (Cloudflare D1) | GPU pour l'entraînement (gratuit possible sur Colab ou Kaggle, selon les quotas du moment) |
| **Idéal pour** | Méthodes, règles, chartes, exemples avec images, informations qui changent | Ton, langue (lingala, swahili, kikongo, tshiluba), manière de répondre, contexte congolais |

Les deux se complètent : le modèle entraîné apprend *comment* répondre, la base de connaissances
lui fournit *quoi* répondre, à jour.

---

## 1. La base de connaissances (déjà active)

1. Chaque question est rattachée à un **domaine** (design UX/UI, comptabilité, développement…)
   grâce aux mots-clés du domaine.
2. Les **fiches validées** de ce domaine qui correspondent à la question sont données à l'IA,
   avec leurs **images d'exemple**. Les fiches **épinglées** (charte graphique, règles de base du
   SYSCOHADA…) sont toujours fournies.
3. Après la réponse, si la personne a **accepté le partage** (ou si c'est vous), l'échange est
   gardé **anonymisé** et une IA en tire au plus 3 fiches réutilisables.
4. Ces fiches arrivent dans **À valider** du tableau de bord (`https://<votre-url>/admin/`).
   Vous relisez, corrigez, ajoutez une image, puis validez. Les fiches tirées de **vos**
   conversations sont validées d'office (réglage `VALIDATION_AUTO_ADMIN`).

Pourquoi une validation ? Sans elle, une erreur d'une IA ou un utilisateur malveillant pourrait
« empoisonner » la base, et l'erreur serait ensuite répétée à tout le monde.

Chaque domaine peut être téléchargé comme un **fichier Markdown** (`design-ux-ui.md`,
`comptabilite.md`…) : c'est aussi votre sauvegarde.

---

## 2. Collecter de bons exemples

Les exemples d'entraînement viennent des conversations **avec consentement** :

- vos propres conversations (administrateur) ;
- celles des utilisateurs qui ont répondu « Oui » au bandeau de partage.

Les boutons 👍 / 👎 sous chaque réponse servent à trier : à l'export, vous pouvez exclure les
réponses notées 👎, ou ne garder que les 👍.

Conseils :

- Privilégiez la **qualité** à la quantité. Quelques centaines d'exemples bien choisis suffisent
  pour un premier essai ; il en faut davantage pour un gain net et stable.
- Pour un « modèle de la RDC », ce qui fait la différence, ce sont les exemples **que les
  modèles généralistes ratent** : questions en langues nationales, réalités locales (franc
  congolais et dollar, SYSCOHADA, démarches administratives), vocabulaire du terrain.
  Rédigez vous-même des paires question / bonne réponse sur ces sujets : ce sont vos exemples
  les plus précieux, et vous en êtes l'auteur.

---

## 3. Les licences : ce que vous avez le droit d'utiliser

**Point important.** Chaque exemple garde le nom du modèle qui a produit la réponse. Certaines
conditions interdisent d'utiliser ces réponses pour entraîner un autre modèle. Les conditions de
l'API Gemini, par exemple, interdisent d'utiliser le service pour développer des modèles qui lui
font concurrence.

L'onglet **Entraînement** du tableau de bord classe chaque modèle :

- **Autorisé** : licences ouvertes (Llama, Qwen, DeepSeek, gpt-oss…), souvent avec des
  conditions (par exemple la licence Llama demande de mentionner « Llama » dans le nom d'un
  modèle distribué) ;
- **À vérifier** : Mistral, Gemma ;
- **Interdit** : Gemini.

Par défaut, l'export ne garde que les modèles **autorisés**. Les règles sont dans
`src/config.ts` → `POLITIQUE_ENTRAINEMENT` : vérifiez-les vous-même dans les licences à jour.
Ce classement est indicatif et ne constitue pas un avis juridique.

---

## 4. Entraîner l'adaptateur LoRA

1. **Exportez** le fichier `.jsonl` depuis l'onglet **Entraînement**. Chaque ligne est une
   conversation au format « chat » (`system`, `user`, `assistant`), accepté par la plupart des
   outils d'entraînement.
2. **Relisez-le** : l'anonymisation masque les courriels, les numéros et les clés, mais pas les
   noms de personnes ou d'entreprises. Retirez ce qui est sensible.
3. **Choisissez un modèle de base** que Workers AI sait servir avec un adaptateur LoRA. La
   documentation cite par exemple `@cf/mistral/mistral-7b-instruct-v0.2-lora`. Vérifiez la liste
   à jour des modèles « LoRA » dans le catalogue Workers AI.
4. **Entraînez** avec un notebook d'Unsloth (Google Colab ou Kaggle) pour ce modèle de base.
   Remplacez le jeu de données d'exemple du notebook par le vôtre :

   ```python
   from datasets import load_dataset
   ds = load_dataset("json", data_files="entrainement.jsonl", split="train")
   # Certains modèles (dont Mistral 7B v0.2) n'ont pas de rôle "system" :
   # on le fusionne alors dans le premier message de l'utilisateur.
   def preparer(ex):
       msgs = ex["messages"]
       if msgs and msgs[0]["role"] == "system":
           systeme, reste = msgs[0]["content"], msgs[1:]
           reste[0] = {"role": "user", "content": systeme + "\n\n" + reste[0]["content"]}
           msgs = reste
       return {"text": tokenizer.apply_chat_template(msgs, tokenize=False)}
   ds = ds.map(preparer)
   ```

   Contraintes de Workers AI pour l'adaptateur : **rang 8** de préférence (jusqu'à 32 accepté),
   fichiers nommés exactement `adapter_config.json` et `adapter_model.safetensors`, chaque
   fichier sous **300 Mo**, et `model_type` égal à `mistral`, `gemma` ou `llama` dans
   `adapter_config.json`.
5. **Testez** l'adaptateur sur des questions qu'il n'a jamais vues, et comparez avec le modèle de
   base. S'il fait moins bien, n'allez pas plus loin : ajoutez de meilleurs exemples.

---

## 5. Brancher votre modèle dans l'orchestrateur

```bash
# Envoyer l'adaptateur sur Workers AI
npx wrangler ai finetune create @cf/mistral/mistral-7b-instruct-v0.2-lora mon-modele-rdc ./adaptateur
npx wrangler ai finetune list

# Le déclarer dans l'orchestrateur
npx wrangler secret put CF_API_TOKEN     # jeton avec accès à Workers AI
npx wrangler secret put CF_ACCOUNT_ID
```

Puis dans `wrangler.toml` → `[vars]` :

```toml
MON_MODELE_LORA = "mon-modele-rdc"
MON_MODELE_TACHES = "chat,summary"   # tâches où votre modèle passe en premier
# MON_MODELE_BASE = "@cf/mistral/mistral-7b-instruct-v0.2-lora"
# MON_MODELE_RAW = "true"            # si votre adaptateur attend un autre modèle de conversation
```

Après `npm run deploy`, votre modèle est essayé **en premier** pour ces tâches, et l'en-tête
`X-Routed-To` affiche `rdc/…`. S'il échoue ou atteint une limite, l'orchestrateur bascule
automatiquement vers les autres modèles, comme d'habitude. Il continue aussi de recevoir les fiches
de la base de connaissances.

À la documentation du moment, les LoRA de Workers AI sont en version bêta et gratuits pendant
cette période. Vérifiez les conditions et les quotas actuels avant de compter dessus.

---

## 6. Le cycle complet

```
Conversations ──► fiches à valider ──► base de connaissances ──► meilleures réponses (immédiat)
      │
      └──► exemples anonymisés + 👍/👎 ──► export autorisé ──► LoRA ──► votre modèle (périodique)
```

Recommencez l'entraînement quand vous avez réuni assez de nouveaux bons exemples : chaque
version de votre modèle est une nouvelle « finetune » (`mon-modele-rdc-v2`…). Vous changez
`MON_MODELE_LORA` pour passer de l'une à l'autre, et vous pouvez revenir en arrière à tout moment.
