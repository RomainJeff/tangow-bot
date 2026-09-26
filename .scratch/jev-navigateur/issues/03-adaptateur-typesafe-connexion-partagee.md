# 03: Adaptateur TypeSafe derrière une connexion partagée

> **Livré autrement (lot 1, 2026-09-26) : adaptateur OpenRouter, pas TypeSafe en direct.** Jev passe par l'API Decisions d'OpenRouter (`POST {baseUrl}/api/alpha/decisions`, alpha, gardée volontairement), `fetch` simple, **aucun SDK** : `@typesafe-ai/sdk` n'est pas une dépendance, `TYPESAFE_API_KEY` n'existe nulle part. Les sections « SDK », « adaptateur », « connexion » et « mode enregistré » ci-dessous sont **historiques** ; ce qui a réellement été livré est dans « Livré » en fin de ticket.

**What to build:** Un opérateur ou un espace qui renseigne une connexion « fournisseur de décision » — un identifiant de fournisseur, une URL de base, un identifiant de modèle et une clé — obtient un `DecisionProvider` réel qui traduit vers `@typesafe-ai/sdk`. Sans connexion, rien n'est instancié, rien n'est importé au chemin chaud, et le cœur tourne comme avant. C'est le seul ticket du lot qui touche un SDK vendeur, et il ne le touche que dans ce fichier.

## ~~Ce que le cadrage a établi sur le SDK~~ (historique, SDK non utilisé)

Vérifié dans `src/types.ts` et `src/client.ts` du dépôt `typesafe-ai/typesafe-sdk-js` :

- Construction : `new TypeSafeClient({ apiKey, baseURL, defaultModel, timeout, retry, fetch, logger, logLevel, defaultHeaders })`. Sans `apiKey` ni `TYPESAFE_API_KEY` dans l'environnement, le constructeur lève `missingApiKey`. **Nous passons toujours `apiKey` explicitement et n'instancions jamais sans** ; la variable d'environnement n'est ni lue ni documentée chez nous (`NON-GOALS.md`).
- Appel : `client.systemOne({ state, questions, model? }, { signal, timeout, retry })` → `POST ${baseURL}/v1/systemone`, corps JSON tel quel. Réponse `{ model, answers, usage: { input_tokens, output_tokens } }`. `answers[k]` : `{ type: "noul", noul }`, `{ type: "choice", choice, confidence, probabilities }`, `{ type: "score", score, confidence, legend, probabilities }`.
- Helpers : `noul(instructions?, criteria?)`, `choice(instructions, { label: description | null })`, `score(instructions, [levels])`. Les descriptions d'option acceptent chaîne, objet JSON ou `null`.
- Erreurs : `APIError` (non-2xx, avec statut), `APITimeoutError`, `APIConnectionError`, `APIUserAbortError`, `TypeSafeError` (configuration). Retry avec backoff par défaut sur certains statuts et sur timeout/connexion ; `respectRetryAfter`.
- Pas de batching, pas de streaming, pas de limite documentée de taille de `state` dans le code.

## Ce que l'adaptateur fait

`TypeSafeDecisionProvider` dans `packages/adapters/src/typesafe-decision.ts` :

- Traduit `DecisionRequest` en `systemOne` : `state` passé tel quel, questions mappées primitive par primitive, `model` depuis la connexion.
- Passe `signal` et `timeout` par appel, avec `retry: { maxRetries: 0 }` : c'est `decideWithin` (ticket 02) qui borne le temps total, et un retry interne consommerait ce budget sans que l'appelant le voie. Un fournisseur de décision qui met 1,5 s a déjà perdu contre le tour de modèle.
- Traduit les erreurs en `unavailable(error)` avec le nom de classe, jamais le message brut (il peut contenir l'URL).
- Renvoie `usage.input_tokens` dans `DecisionResult.usage` quand présent.
- `describe()` : `noul`, `choice`, `score` vrais, `maxOptions` à la valeur lue dans la documentation officielle une fois joignable (placeholder : 80, la borne du snapshot, en attendant), `offline` faux.

## La connexion

Ni variable d'environnement vendeur ni champ ad hoc : le patron `memory-provider-factory.ts` — un identifiant de fournisseur, des `settings` (`endpoint`, `modelId`), des `credentials` (`apiKey`), une étape `prepare` qui valide la forme sans sonder, et `requiresDeploymentOwner` vrai pour un endpoint privé, avec la même classification que Serenity (`classifySerenityConnectionSettings`). Défauts appliqués dans l'adaptateur seulement : `endpoint` vide → l'URL de base du SDK, `modelId` vide → ~~**`jev-1.13.0`, épinglé**~~ `typesafe/jev-1.13` (id OpenRouter versionné, pas l'alias `~typesafe/jev-latest`) (décision du ticket 01 : `jev-latest` bouge sous nous et invaliderait silencieusement le seuil calibré ; la réponse porte la version qui a répondu, que 08 logue). Un opérateur qui pointe vers un proxy ou un endpoint compatible le fait par `endpoint`, pas par une variable.

Portée à trancher à l'implémentation, écrite ici pour ne pas la redécouvrir : le patron mémoire est **par espace** (`MemoryProviderResolver.resolve(spaceId)`), et c'est ce qui permet le consentement par destinataire du ticket 07. Une portée déploiement seule (réglage d'opérateur) simplifie la résolution mais rend le destinataire invisible dans le statut de consentement d'un espace qui ne l'a pas choisi. Recommandation : par espace, comme la mémoire, avec la même possibilité d'une connexion de déploiement par défaut si elle existe déjà pour la mémoire — à vérifier dans `memory-provider-factory.ts` avant de dupliquer.

## Mode enregistré pour la conformité

L'adaptateur passe `assertDecisionConformance` (ticket 02) avec un `fetch` injecté qui rejoue des réponses figées — le seam `fetch` est prévu par le SDK. Les réponses figées sont capturées une fois, à la main, par un script hors CI qui exige une clé (`scripts/` ou `packages/testkit`), et stockées sous `packages/adapters/src/fixtures/` avec la requête correspondante, sans texte de page réel — des pages de fixture seulement. C'est la coupure « CI sans credential / validation manuelle avec credential » de `jev-use`. Aucun test de `pnpm test` ne parle à `api.typesafe.ai`.

## Fichiers

- `packages/adapters/src/typesafe-decision.ts` — l'adaptateur, seul fichier qui importe `@typesafe-ai/sdk`.
- `packages/adapters/src/decision-provider-factory.ts` — ajout du fournisseur, résolution par espace.
- `packages/adapters/package.json` — dépendance `@typesafe-ai/sdk`, épinglée.
- `packages/adapters/src/typesafe-decision.test.ts` — traduction requête/réponse, erreurs, `maxRetries: 0`, `signal`, aucun appel sans clé.
- `packages/adapters/src/decision-conformance.test.ts` — cas « typesafe (enregistré) ».
- Schéma et API de connexion : le même chemin que les connexions mémoire (`packages/db/prisma/schema.prisma`, `apps/api/src/router.ts`), à lire avant d'ajouter une table ; l'attente est de réutiliser la table de connexions existante avec un nouveau `provider`, pas d'en créer une.
- `docs/self-host.md` — un paragraphe : ce que la connexion fait, qu'elle est optionnelle, ce qui part au destinataire (renvoi vers 07).

## Vérification

Offline : conformité en mode enregistré, tests de traduction avec `fetch` injecté. Manuel et hors CI : le script de capture, documenté, qui exige la clé et produit les fixtures.

## Ce qui reste ouvert

- Import différé du SDK (`import()` dans la factory quand la connexion existe) ou import statique dans l'adaptateur : `AGENTS.md` réserve le dynamique au chargement différé nécessaire. Le SDK est petit ; import statique dans `typesafe-decision.ts`, qui n'est lui-même touché que par la factory, devrait suffire. À vérifier au bundle.
- Le SDK expose `dangerouslyAllowBrowser` : l'adaptateur ne tourne que côté API/worker ; aucun client n'en a besoin. À affirmer par un test de non-export vers `apps/web`.

**Blocked by:** 02

**Status:** done (lot 1, 2026-09-26), sous la forme OpenRouter

- [x] Sans connexion : aucune instanciation, aucun appel réseau, comportement inchangé (`SpaceDecisionProviderResolver.resolve` rend `null`)
- [x] Connexion invalide (clé absente, `baseUrl` non HTTP(S), avec identifiants, requête, fragment, ou adresse de métadonnées cloud) : `prepare` refuse avec un message clair, rien n'est enregistré. *Écart : une clé sans modèle est acceptée, le modèle par défaut s'applique dans l'adaptateur.*
- [x] ~~`TYPESAFE_API_KEY`~~ Aucune variable d'environnement de fournisseur de décision n'est lue ; ni `TYPESAFE_API_KEY` ni `OPENROUTER_API_KEY` ne servent ici
- [x] ~~`retry.maxRetries` vaut 0~~ Une seule tentative (pas de reprise), `signal` propagé à `fetch` ; un `signal` annulé n'émet pas de requête
- [x] Les erreurs deviennent `unavailable(error)` avec le nom de classe seulement (`OpenRouterDecisionHttpError` porte le statut, jamais l'URL ni le corps ; `OpenRouterDecisionResponseError` pour un corps non JSON)
- [x] La conformité passe en replay ; la fixture est l'exemple documenté d'OpenRouter, sans page réelle, URL de client ni clé
- [x] Un endpoint privé (loopback, réseau privé, nom LAN, HTTP en clair) exige le propriétaire du déploiement, à l'enregistrement et à la résolution

## Livré

- **Adaptateur** `packages/adapters/src/openrouter-decision.ts` : `OpenRouterDecisionProvider`, fournisseur `openrouter`, `baseUrl` défaut `https://openrouter.ai`, chemin `/api/alpha/decisions`, modèle défaut `typesafe/jev-1.13`, `maxOptions` 255 (limite documentée d'un `choice`), `offline` faux. Corps `{ model, state, questions }` ; les options d'un `choice` et les niveaux d'un `score` partent en `criteria`. Réponse : seuls les champs documentés sont copiés (`legend`, `id`, `provider` ignorés), rien n'est inventé ; `model`, `usage.input_tokens` → `inputTokens`, `usage.cost` → `cost`.
- **Connexion par espace**, table dédiée `SpaceDecisionConfig` (`spaceId` unique, `userId`, `provider`, `settings` JSON, `secretId`) et migration `20260926000000_space_decision_config`. *Écart : pas de réutilisation de la table mémoire, pas de connexion de déploiement par défaut.* Settings stockés seulement s'ils sont renseignés (`baseUrl`, `modelId`), clé chiffrée dans `Secret` (`kind: "decision-provider"`).
- **API** `apps/api/src/decision-provider-config.ts` + `router.ts` : `decision.providerConfig`, `connectProvider`, `disconnectProvider` (`packages/contracts/src/rpc.ts`), propriétaire d'espace requis, endpoint privé réservé au propriétaire du déploiement.
- **Résolution** `decision-provider-factory.ts` : map `DECISION_PROVIDER_ADAPTERS`, `SpaceDecisionProviderResolver` câblé dans `apps/worker/src/index.ts` et passé à l'exécuteur (`ExecutorDeps.decisionProviders`).
- **UI** : `apps/web/src/pages/BrowserSettingsPanel.tsx`, Réglages → Navigateur sur web et desktop (clé OpenRouter, puis base URL et modèle sous « Advanced ») ; **pas d'écran mobile**.
- **Fixtures** : `fixtures/openrouter-decision.json`, recopiée de l'exemple documenté de `https://openrouter.ai/openapi.json` (opération `createApiAlphaDecisions`) ; aucune réponse capturée en direct, **aucun script de capture** (reporté au ticket 06).
- **Tests** `openrouter-decision.test.ts` (requête/réponse documentées, validation, erreurs, abandon, défauts, endpoint privé, résolveur) et `apps/api/src/decision-provider-config.test.ts`.
- **Doc** `docs/self-host.md` : un paragraphe (optionnel, clé propre à l'espace, séparée de `OPENROUTER_API_KEY`, aucune variable lue).
