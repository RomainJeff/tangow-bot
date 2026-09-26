# 02: Interface `DecisionProvider`, fake en process et conformité offline

> **Livré (lot 1, 2026-09-26).** Contrat dans `packages/adapter-kit/src/types.ts` (`DecisionCapabilities`, `DecisionQuestion`, `DecisionRequest`, `DecisionAnswer`, `DecisionResponse`, `DecisionUnavailableReason`, `DecisionResult`) et `interfaces.ts` (`DecisionProvider`). `decideWithin(provider, request, context, { timeoutMs })` et `topChoices` dans `packages/adapters/src/decision.ts` ; fake scripté dans `fake-decision.ts` ; conformité dans `decision-conformance.test.ts`. Le texte ci-dessous est l'intention d'origine ; les écarts sont listés en fin de ticket.

**What to build:** Un contrat neutre dans `packages/adapter-kit` pour « poser des questions typées sur un état texte et recevoir des réponses avec probabilités », un fake déterministe qui y répond sans réseau, et une suite de conformité offline que tout adaptateur futur doit passer. Rien de ce ticket ne nomme TypeSafe ni Jev : c'est le patron `BrowserProvider` / `FakeBrowserProvider` / `browser-conformance.test.ts`, appliqué à une décision au lieu d'une page.

## Le contrat

Trois primitives, parce que ce sont celles que le modèle expose et que les deux usages du lot (04 et 05) n'en utilisent que deux :

- `noul` — une question oui/non, réponse : probabilité du oui.
- `choice` — une question à options closes nommées par l'appelant, réponse : l'option retenue, sa confiance, la distribution sur toutes les options.
- `score` — une échelle bornée de niveaux nommés, réponse : le niveau, sa confiance, la distribution. Inclus dans le contrat pour ne pas le rouvrir, mais aucun ticket de ce lot ne l'appelle ; la conformité le couvre a minima.

La requête porte un `state` (chaîne ou objet JSON), une map nommée de questions, et le `signal` du contexte comme partout ailleurs (`AdapterContext.signal`). La réponse porte une réponse par question et un `usage` (tokens d'entrée) quand le fournisseur le donne, absent sinon — jamais un zéro inventé, même règle que `cacheRead` au ticket 01 du lot `harness-context-quality`.

`describe()` rend un `AdapterDescriptor` avec des capacités : `noul`, `choice`, `score` (booléens), `maxOptions` (borne d'options d'un `choice` que l'adaptateur garantit), `offline` (vrai pour le fake, comme `CloudAgentCapabilities.offline`). L'appelant ne dépasse jamais `maxOptions` ; c'est lui qui tronque ou renonce, pas l'adaptateur.

**Ce que le contrat interdit, par construction.** Une réponse `choice` doit être une clé de la map d'options fournie ; la couche d'appel générique (pas chaque appelant) le vérifie et transforme toute autre valeur en erreur `invalid_answer`. Les probabilités doivent sommer à 1 ± tolérance ; sinon même erreur. C'est le « la réponse doit être un des identifiants fournis avant que le runner la résolve » de `jev-use`, posé une fois au bon endroit.

**Ce que le contrat promet aux appelants.** Une fonction d'enveloppe unique — `decideWithin(provider, request, { timeoutMs })` — qui rend soit une réponse, soit un résultat `unavailable` avec une raison close (`no_provider`, `timeout`, `error`, `invalid_answer`, `not_consented`), et qui **ne lève jamais**. Tous les usages du lot passent par elle, et tous traitent `unavailable` comme « fais comme aujourd'hui ». C'est le `JEVKIT_DISABLE=1 → unavailable` de `jevkit`, mais c'est le chemin normal quand rien n'est configuré, pas un mode.

## Le fake

`FakeDecisionProvider` dans `packages/adapters/src/fake-decision.ts`, en process, sans réseau. ~~Deux comportements, choisis à la construction :~~ *Écart : scripté seulement.*

- **scripté** : une file de réponses fournie par le test, consommée dans l'ordre (le patron `startModelEmulator` du testkit) ; permet aux tests de 04 et 05 de forcer « confiant », « hésitant », « `none` », « option hors table », « lent », « erreur ».
- ~~**par règle**~~ (non livré) : sans script, répond par une heuristique déterministe lisible — pour `choice`, l'option dont la description contient le plus de mots de l'instruction, confiance proportionnelle à l'écart avec la deuxième ; pour `noul`, 0,5. Suffisant pour la conformité et pour un dépôt qui tourne sans vendeur ; il n'a pas vocation à être bon.

Le fake expose ~~les mêmes seams d'erreur que `FakeBrowserProvider` (`forceUnavailable`, `latencyMs`, `decideError`)~~ `latencyMs` et `decideError` pour les tests de repli ; `unavailable` s'obtient par un fournisseur absent, une erreur ou un pas scripté malformé.

## La conformité

`packages/adapters/src/decision-conformance.test.ts`, une fonction `assertDecisionConformance(provider)` appliquée au fake, et plus tard à tout adaptateur en mode enregistré (ticket 03). Elle vérifie : les capacités annoncées sont honorées ; un `choice` rend une clé de la map avec une distribution qui somme à 1 ; un `noul` rend un nombre dans [0, 1] ; un `signal` déjà annulé rend `unavailable(aborted)` sans appel ; une réponse hors table est convertie en `unavailable(invalid_answer)` par l'enveloppe ; `decideWithin` respecte son délai et ne lève pas.

## Fichiers

- `packages/adapter-kit/src/types.ts` — `DecisionCapabilities`, `DecisionQuestion` (`noul | choice | score`), `DecisionRequest`, `DecisionAnswer`, `DecisionResult`, `DecisionUnavailable` ; à côté des types `Browser*` (~ligne 710) pour que le lecteur voie le lien.
- `packages/adapter-kit/src/interfaces.ts` — `DecisionProvider { describe(); decide(request, context) }`, à côté de `BrowserProvider` (ligne 399), avec le même style de commentaire d'intention (« provider-neutral », « not a vendor »).
- `packages/adapter-kit/src/index.ts` — exports.
- `packages/adapters/src/decision.ts` — `decideWithin`, validation des réponses, raisons closes.
- `packages/adapters/src/fake-decision.ts` — le fake.
- `packages/adapters/src/decision-provider-factory.ts` — `createDecisionProvider(kind, options)` rendant `undefined` quand rien n'est configuré et le fake en `fake` ; le vrai adaptateur y est ajouté au ticket 03.
- `packages/adapters/src/decision-conformance.test.ts`.

## Vérification

Déterministe et offline : vitest sur le fake seul. Aucun test de ce ticket ne touche le réseau, aucune clé, aucun sandbox.

## Ce qui reste ouvert

- Où passe le provider aux outils : par `ExecutorDeps` comme `browser`, `web`, `cloudAgent` (`executor.ts:1643` pour `browser`), résolu une fois par run. À confirmer au ticket 03 quand la connexion partagée existe, car un provider par espace (patron mémoire) se résout par `spaceId` et pas au démarrage.
- `score` reste-t-il dans le contrat sans appelant ? Le laisser coûte trois lignes de conformité ; le retirer oblige à rouvrir `adapter-kit` si 06 veut une échelle de confiance en lecture humaine. Laisser, sans le documenter comme disponible aux outils.

**Blocked by:** 01

**Status:** done (lot 1, 2026-09-26)

- [x] `DecisionProvider` et ses types sont dans `adapter-kit`, sans mot vendeur dans les noms, les commentaires ni les tests
- [x] `decideWithin` ne lève jamais ; `no_provider`, `timeout`, `error`, `invalid_answer`, `aborted` sont couverts par un test chacun
- [x] Une réponse `choice` hors de la map d'options ne sort jamais de l'enveloppe autrement qu'en `unavailable(invalid_answer)`
- [x] Le fake scripté permet de forcer chaque cas ; ~~le fake par règle est déterministe~~ (pas de mode par règle)
- [x] ~~`createDecisionProvider()` sans configuration rend `undefined`~~ `SpaceDecisionProviderResolver.resolve(spaceId)` rend `null` sans connexion, et un run sans provider est strictement inchangé (`browser-targets.test.ts`, « leaves the schema and ref results unchanged without a provider »)
- [x] La conformité tourne dans `pnpm test` sans variable d'environnement

## Livré — écarts avec le texte ci-dessus

- **Raisons closes** : `no_provider | timeout | aborted | error | invalid_answer`. Pas de `not_consented` : il n'y a pas de porte de consentement côté serveur (ticket 07). Après `aborted`, l'appelant relance l'abandon du run (`context.signal.throwIfAborted()` dans `browser-tools.ts`).
- **Nommage** : la réponse d'un fournisseur est `DecisionResponse` (`answers`, `model?`, `usage?: { inputTokens?, cost? }`) ; `DecisionResult` est l'union `{ ok: true } & DecisionResponse | { ok: false, reason, error? }`. Une réponse `noul` porte `probability`. `error` ne porte que le nom de classe.
- **Validation** : `decideWithin` refuse avant appel une requête que les capacités ne couvrent pas (primitive absente, `choice` vide ou au-delà de `maxOptions`, `score` à moins de deux niveaux) → `unavailable(error, "UnsupportedDecisionRequest")`. Après appel : clé hors map, distribution qui ne somme pas à 1 ± 1e-3, ou **option choisie absente de `probabilities`** → `invalid_answer`. Le délai est une course (`Promise.race`), donc un fournisseur qui ignore son `signal` ne retient pas l'appelant.
- **Fake** : scripté seulement (`script`, `maxOptions` défaut 255, `latencyMs`, `decideError`, `calls`) ; ni mode par règle, ni `forceUnavailable`. Un script épuisé lève.
- **Conformité** : `assertDecisionConformance` tourne contre l'adaptateur OpenRouter (`fetch` injecté, fixture documentée `fixtures/openrouter-decision.json`) ; les cas d'enveloppe (délai, abandon, erreur, hors table, `maxOptions`, logs sans contenu) tournent sur le fake. Requêtes de fixture neutres dans `fixtures/decision-requests.ts`.
- **Fabrique** : pas de `createDecisionProvider(kind)` avec un `fake` ; `decision-provider-factory.ts` est une map `DECISION_PROVIDER_ADAPTERS` (seul `openrouter`) et un `SpaceDecisionProviderResolver` par espace (ticket 03).
- **Branchement** (question ouverte tranchée) : `ExecutorDeps.decisionProviders` (résolveur), résolu une fois au démarrage du run par `spaceId` ; une erreur de résolution donne `null` et le run continue (`executor.ts`).
- **Log** : `decideWithin` émet `agent.decision.call` à chaque appel (ticket 08).
- `score` est resté dans le contrat, sans appelant.
