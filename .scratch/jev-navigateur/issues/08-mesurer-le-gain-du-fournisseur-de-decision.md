# 08: Mesurer ce que le fournisseur de décision rapporte réellement

> **Émission livrée (lot 1, 2026-09-26), logs seulement.** Trois lignes de log, ni `UsageRecord` ni colonnes `ExternalEffect`. La lecture des chiffres (section « La question que les chiffres doivent trancher ») reste à faire : elle demande un espace connecté avec une vraie clé. Écarts en fin de ticket.

**What to build:** Un opérateur qui regarde ses logs peut répondre à « combien de `browser_act` sont passés par `target`, combien ont été exécutés directement, combien ont été rendus au modèle, en combien de temps, et est-ce que les runs navigateur consomment moins de tours et de tokens qu'avant ? ». Sans ce ticket, le lot livre une capacité dont personne ne saura si elle vaut sa connexion, et le ticket 01 a écrit que le gain de justesse n'est pas démontré.

## Ce qui existe déjà et qu'on réutilise

- Le log de run compte déjà tokens estimés, messages retenus et compteurs de cache (ticket 01 du lot `harness-context-quality`, mergé `cb407626`). La baisse attendue — moins de snapshots dans le contexte du modèle — se lit là, à condition de savoir quels runs ont utilisé `target`.
- ~~`ExternalEffect` porte `reviewDecision`, `reviewReason`, `reviewModel` pour le juge d'approbation (`packages/db/prisma/schema.prisma:682`). Un `browser_act` à effet est déjà enregistré comme effet ; la décision qui l'a ciblé peut vivre à côté sans nouvelle table.~~ *Non retenu (mainteneur) ; `browser_act` est d'ailleurs exempté d'approbation (`action-approval.ts`).*
- Le contrat de télémétrie neutre câblé au ticket 17 du même lot (spans, no-op, adaptateur vers le logger) est l'endroit pour la latence d'un appel de décision, pas un chronométrage maison.

## Ce qu'on émet

Compteurs et identifiants, jamais de contenu : ni `target`, ni noms d'éléments, ni texte de page.

- Par appel de décision : durée, raison si `unavailable` (`no_provider`, `timeout`, `error`, `invalid_answer`, ~~`not_consented`~~ `aborted`), nombre d'options, confiance retournée, `usage.input_tokens` quand présent, modèle du fournisseur (`answers.model`).
- Par `browser_act` à `target` : `executed | returned_low_confidence | returned_none | returned_unavailable`, et pour 05 : `outcome.kind` et sa confiance.
- ~~Sur l'effet : `decisionConfidence`, `decisionOutcome`, `decisionModel` sur `ExternalEffect`, dans le même esprit que `review*` — le raccordement entre une décision et son effet est ce qui permettra, si un clic a été faux, de retrouver la confiance qu'il avait.~~ (non livré)
- Par run : `decisionCalls`, `decisionExecuted`, `decisionReturned`, à côté des compteurs existants, pour croiser avec tokens et nombre de tours.

## La question que les chiffres doivent trancher

Après au moins sept jours de runs navigateur avec un fournisseur connecté, écrire avant de lire :

- Si les runs avec `target` ont **moins de tours de modèle par action navigateur** (médiane) et **moins de tokens d'entrée par run** que les runs sans, à tâches comparables, le lot a atteint son but ; 06 peut resserrer ou relâcher `high`.
- Si `returned_low_confidence + returned_none` dépasse 40 % des `target`, le modèle finit par relire la page presque à chaque fois et le coût est un appel d'outil et un appel fournisseur en plus, pas en moins : désactiver `target` par défaut et rouvrir 06 avec les cas réels (anonymisés en familles, jamais en pages).
- Si la latence médiane d'un appel de décision dépasse 500 ms, revoir le budget de `decideWithin` ou le `state` ; au-delà d'une seconde, la valeur temps est perdue.
- Pour 05 : la part d'`outcome = auth` suivie d'un `request_takeover` dans les trois tours est le signe que la classe sert ; si elle est nulle, la phrase d'instruction est à revoir ou la classe ne se déclenche pas.

## Fichiers

- `packages/adapters/src/decision.ts` — émission des spans/lignes depuis `decideWithin` (un seul point).
- `packages/adapters/src/browser-tools.ts` — l'issue de résolution (`executed | returned_*`).
- `packages/adapters/src/executor.ts` — compteurs par run à côté des compteurs de contexte ; écriture sur `ExternalEffect`.
- ~~`packages/db/prisma/schema.prisma` + migration additive — trois colonnes optionnelles sur `external_effects`.~~ (non livré)
- Tests : le logger de test existant pour les compteurs de run ; assertion qu'aucune ligne ne contient un nom d'élément ni un fragment de `state`.

## Vérification

Offline : tests unitaires sur l'émission avec fake scripté et logger capturé ; un test qui passe un `target` et un `state` contenant un marqueur improbable et affirme que le marqueur n'apparaît dans aucune ligne émise.

## Ce qui reste ouvert

- Destination des agrégats : comme au ticket 09 du lot voisin, sans exportateur configuré il n'y a pas d'agrégat, seulement des lignes. Les seuils ci-dessus supposent qu'un opérateur peut les calculer ; sinon la mesure se fait sur un déploiement de test avec la connexion et le corpus de 06 en boucle.
- La comparaison « avec / sans » demande des tâches comparables. Le plus honnête est A/B par espace sur un même déploiement, pas avant/après dans le temps.

**Blocked by:** 04 (05 ajoutera ses propres lignes, voir ci-dessous)

**Status:** done (lot 1, 2026-09-26, logs seulement) — lecture des chiffres en attente d'une vraie clé

- [x] Chaque appel de décision émet durée, raison, nombre d'options, confiance, modèle, tokens d'entrée et coût ; jamais de contenu
- [x] Chaque `browser_act` à `target` émet son issue de résolution
- [ ] ~~`ExternalEffect` porte la confiance et l'issue de la décision associée à un effet navigateur~~ — abandonné
- [x] Les compteurs par run sont émis en fin de run (*écart : ligne séparée `agent.run.decision`, pas dans le log de contexte*)
- [x] Un test affirme qu'aucun fragment de `state` ne fuit dans les lignes émises (`decision-conformance.test.ts`, `browser-targets.test.ts`)
- [ ] Les seuils de lecture ci-dessus sont inchangés au moment de lire, ou la modification est consignée — pas encore lu

## Livré — ce qui est émis

- `agent.decision.call` (`decision.ts`, depuis `decideWithin`, un seul point) : `runId`, `botId`, `spaceId`, `provider` (id d'adaptateur), `durationMs`, `outcome` (`answered` ou la raison `unavailable`), `errorClass`, `questions`, `options`, `confidence` (s'il n'y a qu'une réponse non `noul`), `model`, `inputTokens`, `cost` (`usage.cost` d'OpenRouter). *Pas de champ qui dit à quoi sert l'appel : le ticket 05 doit en ajouter un.*
- `agent.browser.target` (`browser-tools.ts`) : `runId`, `botId`, `kind`, `outcome` (`executed | returned_low_confidence | returned_none | returned_unavailable`), `options`, et selon le cas `confidence`, `probability`, `role`, `reason`.
- `agent.run.decision` (`executor.ts`, `finally` du run, seulement si au moins une résolution a eu lieu) : `decisionCalls`, `decisionExecuted`, `decisionReturned`.
- Pas de span de télémétrie, pas de `UsageRecord` : le coût d'une décision n'entre pas dans la facturation d'usage.

## Quand 05 sera livré

La vérification post-action ajoute un appel de décision par `browser_act` vérifié : latence et coût par action augmentent, et `agent.decision.call` mélangerait les deux usages. Les lignes doivent rester séparables : 05 ajoute un champ `purpose` (`target` | `verify`) à `agent.decision.call`, sa propre ligne `agent.browser.outcome` et des compteurs `verifyCalls` / `verifyAnswered` distincts dans `agent.run.decision`. La mesure du gain de 04 (tours et tokens du modèle principal) se lit alors sur les appels `purpose = target` seulement, et de préférence sur les jours d'avant la livraison de 05.
