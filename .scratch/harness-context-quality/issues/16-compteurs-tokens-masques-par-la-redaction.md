# 16: Rendre les compteurs de tokens lisibles dans les logs

**What to build:** Un opérateur qui lit les logs voit ce que chaque run a coûté en tokens. Aujourd'hui il ne le voit pas : tous les compteurs dont le nom contient `token` sont remplacés par `[Redacted]` par la couche de rédaction, qui les prend pour des secrets.

`shouldRedactKey` (`packages/logging/src/redaction.ts:71-74`) normalise la clé en minuscules et retire tout ce qui n'est pas `[a-z0-9_]` — ce qui écrase les frontières camelCase — puis teste la regex `SECRET_KEY`, qui est **non ancrée** :

```ts
const SECRET_KEY = /password|secret|token|authorization|cookie|credential|apikey/;
```

`historyTokens` devient `historytokens`, contient `token`, et part en `[Redacted]`. `logger.ts:86` applique `redactBindings` à chaque appel de log, donc c'est systématique.

Victimes : tout l'event `agent.run.context` construit au ticket 01 pour mesurer le budget contexte — `instructionTokens`, `toolSchemaTokens`, `historyTokens`, `historyTokensByRole` — plus les compteurs d'usage ailleurs : `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `totalTokens`, `maxTokens`, `nonHistoryTokens`. Survivent dans le même event : `contextWindow`, `toolCount`, `historyMessagesKept`, `historyMessagesAvailable`, `historyWindowMode`.

Le log dit donc combien de messages ont été retenus, mais pas ce qu'ils coûtent — la seule chose pour laquelle il a été écrit. Les tickets 01 à 04 sont instrumentés mais illisibles en production.

## Piste de correctif proposée

Une allowlist en match exact, testée **avant** `SECRET_KEY`, qui réutilise le pattern `REDACT_KEYS` déjà présent dans le fichier :

```ts
// Context and usage counters: numbers, never secrets. Checked before SECRET_KEY, whose
// substring test cannot tell `historyTokens` from `accessToken`.
const COUNTER_KEYS = new Set([
  "historytokens", "historytokensbyrole", "instructiontokens", "toolschematokens",
  "nonhistorytokens", "inputtokens", "outputtokens", "cachereadtokens",
  "cachewritetokens", "totaltokens", "maxtokens",
]);
```

puis `if (COUNTER_KEYS.has(normalized)) return false;` en tête de `shouldRedactKey`.

C'est une frontière de confiance, donc le critère de choix est **comment ça échoue quand quelqu'un se trompe**. L'allowlist échoue du bon côté : un compteur ajouté plus tard est masqué jusqu'à ce qu'on l'ajoute au set — masqué, pas fuité. Coût de maintenance réel mais petit.

## Alternatives écartées, et pourquoi

- **Exempter le suffixe `/tokens$/` (pluriel).** Tient contre toutes les clés actuelles du dépôt : les compteurs sont au pluriel, les secrets au singulier (`accessToken`, `botToken`, `verifyToken`, `slackBotToken`…). Mais un futur `refreshTokens: string[]` fuiterait en silence. Pas acceptable pour trois lignes économisées.
- **Ne pas rédiger les valeurs numériques** (une ligne, couvre automatiquement tout compteur futur). C'est affaiblir un contrôle de sécurité pour réparer une gêne de logging : un code PIN ou un numéro de compte sous une clé `password` se mettrait à fuiter.
- **Correspondance sur frontière de mot.** Impossible sans changer la normalisation — la ligne qui retire les non-alphanumériques écrase les frontières camelCase, il ne reste rien sur quoi ancrer. Restaurer les frontières ne sauve rien non plus : `api_token` matche toujours `\btoken\b`. C'est vraisemblablement pourquoi le test de sous-chaîne existe.

## Pourquoi ça n'a pas été vu

Les 9 tests de `packages/logging/src/redaction.test.ts` passent. Celui qui couvre le sujet assert que la clé **exacte** `token` est rédigée — elle le reste avec l'allowlist. **Aucun test existant n'utilise une clé `*Tokens`.** Cette absence est la cause directe.

**Blocked by:** None (can start immediately)

**Status:** needs-decision — problème et piste documentés, correctif non appliqué

- [ ] Un compteur de tokens apparaît en clair dans les logs ; une clé de secret reste rédigée
- [ ] Les 9 tests de rédaction existants passent sans modification
- [ ] Un test couvre les deux cas dans la même assertion, par exemple `{ historyTokens: 1234, accessToken: "sk-abc" }` → compteur intact, secret rédigé. Il échoue sur le code actuel
- [ ] Aucune valeur de secret ne devient lisible : la liste ajoutée est en correspondance exacte, jamais en sous-chaîne ni en suffixe
