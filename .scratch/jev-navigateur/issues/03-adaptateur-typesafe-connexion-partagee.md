# 03: Adaptateur TypeSafe derrière une connexion partagée

**What to build:** Un opérateur ou un espace qui renseigne une connexion « fournisseur de décision » — un identifiant de fournisseur, une URL de base, un identifiant de modèle et une clé — obtient un `DecisionProvider` réel qui traduit vers `@typesafe-ai/sdk`. Sans connexion, rien n'est instancié, rien n'est importé au chemin chaud, et le cœur tourne comme avant. C'est le seul ticket du lot qui touche un SDK vendeur, et il ne le touche que dans ce fichier.

## Ce que le cadrage a établi sur le SDK

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

Ni variable d'environnement vendeur ni champ ad hoc : le patron `memory-provider-factory.ts` — un identifiant de fournisseur, des `settings` (`endpoint`, `modelId`), des `credentials` (`apiKey`), une étape `prepare` qui valide la forme sans sonder, et `requiresDeploymentOwner` vrai pour un endpoint privé, avec la même classification que Serenity (`classifySerenityConnectionSettings`). Défauts appliqués dans l'adaptateur seulement : `endpoint` vide → l'URL de base du SDK, `modelId` vide → `jev-latest`. Un opérateur qui pointe vers un proxy ou un endpoint compatible le fait par `endpoint`, pas par une variable.

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

**Status:** ready-for-agent

- [ ] Sans connexion : aucune instanciation du client, aucun import exécuté au chemin chaud, aucun appel réseau, comportement inchangé
- [ ] Avec connexion partielle (clé sans modèle, endpoint invalide) : `prepare` refuse avec un message clair, rien n'est enregistré
- [ ] `TYPESAFE_API_KEY` n'apparaît ni dans le code, ni dans les tests, ni dans la doc
- [ ] `retry.maxRetries` vaut 0 et `signal` est propagé ; un `signal` annulé n'émet pas de requête
- [ ] Les erreurs SDK deviennent `unavailable(error)` avec le nom de classe seulement
- [ ] La conformité passe en mode enregistré ; les fixtures ne contiennent aucune page réelle, aucune URL de client, aucune clé
- [ ] Un endpoint privé exige le propriétaire du déploiement, comme la mémoire
