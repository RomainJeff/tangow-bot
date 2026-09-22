# 08: Mesurer ce que le fournisseur de décision rapporte réellement

**What to build:** Un opérateur qui regarde ses logs peut répondre à « combien de `browser_act` sont passés par `target`, combien ont été exécutés directement, combien ont été rendus au modèle, en combien de temps, et est-ce que les runs navigateur consomment moins de tours et de tokens qu'avant ? ». Sans ce ticket, le lot livre une capacité dont personne ne saura si elle vaut sa connexion, et le ticket 01 a écrit que le gain de justesse n'est pas démontré.

## Ce qui existe déjà et qu'on réutilise

- Le log de run compte déjà tokens estimés, messages retenus et compteurs de cache (ticket 01 du lot `harness-context-quality`, mergé `cb407626`). La baisse attendue — moins de snapshots dans le contexte du modèle — se lit là, à condition de savoir quels runs ont utilisé `target`.
- `ExternalEffect` porte `reviewDecision`, `reviewReason`, `reviewModel` pour le juge d'approbation (`packages/db/prisma/schema.prisma:682`). Un `browser_act` à effet est déjà enregistré comme effet ; la décision qui l'a ciblé peut vivre à côté sans nouvelle table.
- Le contrat de télémétrie neutre câblé au ticket 17 du même lot (spans, no-op, adaptateur vers le logger) est l'endroit pour la latence d'un appel de décision, pas un chronométrage maison.

## Ce qu'on émet

Compteurs et identifiants, jamais de contenu : ni `target`, ni noms d'éléments, ni texte de page.

- Par appel de décision : durée, raison si `unavailable` (`no_provider`, `timeout`, `error`, `invalid_answer`, `not_consented`), nombre d'options, confiance retournée, `usage.input_tokens` quand présent, modèle du fournisseur (`answers.model`).
- Par `browser_act` à `target` : `executed | returned_low_confidence | returned_none | returned_unavailable`, et pour 05 : `outcome.kind` et sa confiance.
- Sur l'effet : `decisionConfidence`, `decisionOutcome`, `decisionModel` sur `ExternalEffect`, dans le même esprit que `review*` — le raccordement entre une décision et son effet est ce qui permettra, si un clic a été faux, de retrouver la confiance qu'il avait.
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
- `packages/db/prisma/schema.prisma` + migration additive — trois colonnes optionnelles sur `external_effects`.
- Tests : le logger de test existant pour les compteurs de run ; assertion qu'aucune ligne ne contient un nom d'élément ni un fragment de `state`.

## Vérification

Offline : tests unitaires sur l'émission avec fake scripté et logger capturé ; un test qui passe un `target` et un `state` contenant un marqueur improbable et affirme que le marqueur n'apparaît dans aucune ligne émise.

## Ce qui reste ouvert

- Destination des agrégats : comme au ticket 09 du lot voisin, sans exportateur configuré il n'y a pas d'agrégat, seulement des lignes. Les seuils ci-dessus supposent qu'un opérateur peut les calculer ; sinon la mesure se fait sur un déploiement de test avec la connexion et le corpus de 06 en boucle.
- La comparaison « avec / sans » demande des tâches comparables. Le plus honnête est A/B par espace sur un même déploiement, pas avant/après dans le temps.

**Blocked by:** 04, 05

**Status:** ready-for-agent

- [ ] Chaque appel de décision émet durée, raison, nombre d'options, confiance, modèle ; jamais de contenu
- [ ] Chaque `browser_act` à `target` émet son issue de résolution
- [ ] `ExternalEffect` porte la confiance et l'issue de la décision associée à un effet navigateur
- [ ] Les compteurs par run sont à côté des compteurs de contexte existants
- [ ] Un test affirme qu'aucun fragment de `state` ne fuit dans les lignes émises
- [ ] Les seuils de lecture ci-dessus sont inchangés au moment de lire, ou la modification est consignée
