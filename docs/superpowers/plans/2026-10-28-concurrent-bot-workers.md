# Concurrence des workers d'un bot

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Ce document prépare le travail ; sa création ne déclenche pas l'implémentation.

**Goal:** Permettre au bot de répondre pendant que ses helpers travaillent, avec les mêmes fichiers persistants.

**Architecture:** Les volumes acceptent plusieurs workers de runs différents. L'exclusion concerne les tentatives successives d'un même run. Les opérations de maintenance attendent tous les workers concernés en s'appuyant sur les tentatives déjà enregistrées.

**Tech Stack:** TypeScript, Prisma, PostgreSQL, workers Docker/E2B derrière les contrats existants, Vitest et Playwright.

**Spec:** Le contrat ci-dessous reprend la décision discutée dans cette conversation. Aucun changement d'implémentation n'est inclus dans ce travail de planification.

## Contrat retenu

- Le bot, ses helpers génériques ou gérés, et l'ordinateur conservent leurs accès actuels aux volumes persistants. Aucun espace temporaire de substitution, aucun retrait d'outil.
- Deux runs différents du même bot peuvent avoir chacun un worker actif, quel que soit leur lien de parenté ou leur thread.
- Une nouvelle tentative d'un run attend la destruction confirmée du worker de sa tentative précédente, y compris lorsqu'il est en `releasing` ou que son `ensure` peut encore créer une VM.
- Annuler un helper ne bloque pas les autres runs. Sa VM peut encore écrire jusqu'à sa destruction ; le fence applicatif ne révoque pas un montage de fichiers.
- Les écritures simultanées suivent les garanties actuelles du système de fichiers. Aucun verrou par fichier ni résolution automatique des conflits n'est ajouté ; une modification concurrente du même fichier peut perdre des changements ou interférer avec une commande.
- Une copie, migration ou bascule d'un home attend tous les workers susceptibles d'écrire ses volumes, même si leur run est terminé ou annulé. Une réservation de maintenance empêche un nouveau démarrage dans son périmètre.
- Les limites existantes des providers sur l'échéance d'`ensure` et la destruction restent celles du contrat actuel. On ne promet pas de protéger les fichiers contre un provider qui viole ce contrat.

## Contraintes globales

- Changement backend commun au web, à Electron et au mobile ; aucun changement de parcours ou de copie UI.
- Conserver les contrôles d'autorisation des montages, les fences, la récupération des VM et l'exclusivité de la ressource ordinateur entre helpers.
- Ne pas ajouter de registre multi-écrivains, de provider, de configuration ou de mécanisme de fusion de fichiers.
- Supprimer les anciens consommateurs de `writerAttemptId` dans la même livraison, sans API de compatibilité durable.
- Tests déterministes et hors ligne par défaut. Les courses transactionnelles se prouvent aussi avec PostgreSQL réel, pas seulement PGlite.
- Une seule PR cohérente vers `main`. Les étapes ci-dessous sont dépendantes ; ne pas déployer un état intermédiaire.
- Appliquer le skill `test-audit` aux tests ajoutés ou modifiés. Ne pas lancer les E2E Electron sur la machine du mainteneur.

## Points de revue prioritaires

1. Tentatives successives du même run : conserver le garde du launcher, qui inclut `releasing`, et la distinction entre attente temporaire et échéance provider dépassée. Le claim modifie la ligne du run et `start` vérifie son fence sous verrou ; ne pas modifier ce protocole sans défaut reproduit.
2. Création dont la réponse est perdue : conserver l'attente et le nettoyage par tentative jusqu'à l'échéance provider existante.
3. Réservation de maintenance contre démarrage concurrent : une seule des deux opérations peut être admise ; protéger aussi les homes dédiés.
4. Une VM démarre puis s'arrête pendant une copie : le compteur historique doit invalider l'adoption, même si le nombre de workers vivants est revenu à zéro.
5. Annulation ou destruction impossible d'un helper : les autres runs répondent et ses fichiers restent partagés ; son propre remplacement et la maintenance restent bloqués.

## Carte des changements

- `packages/adapters/src/worker-lifecycle.ts` : suivi de maintenance à partir des tentatives, suppression de l'écrivain unique du volume et du passage redondant des anciennes tentatives en `releasing`.
- `packages/adapters/src/runtime-worker/launcher.ts` : retrait du traitement `VolumeBusyError` ; conservation du garde existant entre tentatives du même run.
- `packages/core/src/worker-plan.ts` : suppression de `takesWriterLease`, `writersBlocking` et du champ correspondant dans `VolumeRow`.
- `packages/adapters/src/e2b-home-upgrade.ts`, `e2b-docker-migration.ts` : remplacement des prédicats de verrou par la réservation de maintenance valide et son périmètre.
- `packages/db/prisma/schema.prisma` et nouvelle migration : suppression de `Volume.writerAttemptId`, de la relation inverse `Attempt.writtenVolumes`, de la FK et de l'index associés.
- Tests propriétaires : `worker-lifecycle.test.ts`, `worker-lifecycle.postgres.test.ts`, `worker-volumes.test.ts`, `home-volume-migration.test.ts`, `e2b-home-upgrade.test.ts`, `e2b-docker-migration.test.ts`, `packages/core/src/worker-plan.test.ts`, `packages/testkit/src/executor-background-helper.test.ts`.
- Fixtures et vérifications existantes : `worker-fixture.test-support.ts`, `packages/testkit/src/docker-worker.docker.test.ts`, `packages/testkit/src/worker-live/lane-faults.ts`.
- `CHANGELOG.md` : résultat observable au jour de livraison. Aucun ajout au changelog pour le plan seul.

## Étape 1 : rendre la protection de maintenance indépendante du verrou du volume

**Interface :** conserver les méthodes publiques de `WorkerLifecycle`. Remplacer `HomeMoveStart.spaceWorkers` par `HomeMoveStart.workerCount`. Supprimer le code `volume_busy` et réutiliser `space_worker_live` et `space_worker_ran` pour les deux scopes afin de limiter le changement de contrat. Le compteur suit tous les workers historiques du périmètre, pas seulement les workers actuellement actifs.

- [ ] Étendre les tests existants de réservation et d'adoption : sur un home dédié, deux workers de runs différents, puis un worker `releasing`, empêchent la copie/adoption jusqu'à leur libération. Un worker ayant démarré et fini depuis l'inspection invalide aussi l'adoption.
- [ ] Vérifier l'échec attendu des nouveaux cas sur le code initial ; les assertions portent sur l'admission de la maintenance et l'intégrité de la copie, pas sur un champ de bail.
- [ ] Généraliser le comptage interne `spaceWorkers` aux workers des bots du computer pour un home dédié et de tout l'espace pour un home d'équipe. Inclure `requested`, `created`, `ready` et `releasing` dans le compte vivant. Le total compte chaque tentative ayant eu un worker, sans filtre de statut du run ni de fence courant.
- [ ] Utiliser ce comptage dans `inspectHomeMove` et `adoptVolumeHome` pour tous les scopes. Garder le marqueur, son échéance en horloge base, les verrous de lignes existants et le contrôle de `homeRevision`.
- [ ] Étendre aux homes dédiés le test PostgreSQL existant `serializes a home move reservation against a worker already planned in the space`. Conserver ses deux résultats possibles : démarrage admis implique maintenance refusée ; réservation admise implique démarrage refusé avant tout appel provider.
- [ ] Dans la transaction de bascule de chacune des deux migrations, verrouiller d'abord les lignes `computers` des marqueurs attendus, triées par id, avec `SELECT ... FOR UPDATE` et `homeMoveExpiresAt > now()` en horloge base. Exiger qu'au moins une réservation valide corresponde à chaque marqueur attendu et que les ordinateurs de la bascule soient couverts. Refuser avant toute modification de volume si une réservation manque ou a expiré. Une réservation d'équipe peut couvrir plusieurs lignes.
- [ ] Conserver les contrôles d'identité du volume/provider et de contenu copié. Ne pas ajouter un compteur historique à ces deux bascules : la réservation valide et verrouillée empêche les démarrages pendant la bascule. Le contrôle `workerCount` reste dans `adoptVolumeHome`, qui peut adopter après une copie sans réservation continue.
- [ ] Garder la protection existante de `packages/db/src/volumes.ts` fondée sur les tentatives ; adapter ses tests de fixtures sans inventer un second inventaire.

Vérification ciblée :

```sh
pnpm exec vitest run packages/adapters/src/worker-lifecycle.test.ts packages/adapters/src/worker-volumes.test.ts packages/adapters/src/home-volume-migration.test.ts packages/adapters/src/e2b-home-upgrade.test.ts packages/adapters/src/e2b-docker-migration.test.ts
```

Résultat attendu : maintenance refusée pendant toute présence possible d'un worker, puis permise après libération ; réservations expirées incapables de basculer un volume.

## Étape 2 : remplacer l'exclusion par volume par l'exclusion par run

**Interfaces :** conserver `WorkerLifecycle.start(launch: WorkerLaunch, context: AdapterContext): Promise<StartedWorker>` et le garde du launcher. Conserver ses erreurs actuelles : `AgentRuntimeBusyError` pendant l'attente et `AgentRuntimeUnavailableError` lorsque l'échéance provider existante est dépassée. Ne pas introduire une nouvelle famille d'erreurs.

- [ ] Inverser les tests existants qui attendent `VolumeBusyError` entre deux runs du même bot, dont le cas PostgreSQL correspondant : les deux workers démarrent et leurs montages privés et partagés restent inchangés.
- [ ] Vérifier l'échec attendu de cette nouvelle assertion sur le code initial. Réutiliser les tests existants du fence, du double démarrage d'une tentative, d'`ensure` perdu et de destruction impossible ; n'ajouter un cas que s'il manque une preuve du remplacement après retrait du verrou.
- [ ] Conserver le contrôle des anciennes tentatives dans le launcher et la validation du fence dans la transaction de `start`. Supprimer le `updateMany` de `start` qui passe les anciennes tentatives vivantes en `releasing` : le garde empêche leur remplacement et le reconciler traite déjà les fences périmés. Garder l'index unique partiel comme filet, sans lui attribuer la protection contre `releasing`.
- [ ] Retirer la prise et la libération de `writerAttemptId`, `VolumeBusyError`, ses traductions dans le launcher, `takesWriterLease` et `writersBlocking`. Garder les verrous et la validation des volumes nécessaires à l'autorisation et à la maintenance.
- [ ] Conserver `release`, `reconcile`, la récupération d'un `ensure` tardif et le nettoyage d'un propriétaire, chacun fondé sur l'attempt. Adapter les tests qui inspectaient seulement le bail pour vérifier l'état du worker et sa destruction effective.
- [ ] Adapter les fixtures, la suite Docker et les lanes live : remplacer les comptages de baux par les preuves de présence, libération et reprise des workers qu'ils étaient censés représenter. Les lanes nécessitant un service externe ne sont pas lancées par défaut.

Vérification ciblée :

```sh
pnpm exec vitest run packages/core/src/worker-plan.test.ts packages/adapters/src/worker-lifecycle.test.ts packages/adapters/src/worker-volumes.test.ts
```

Pour les courses PostgreSQL : `pnpm test:integration`. Le harness démarre PostgreSQL 16 dans un conteneur, configure la base de test et inclut `worker-lifecycle.postgres.test.ts`, avec provider factice. Ne pas utiliser une base de production.

## Étape 3 : prouver la réponse du bot et préserver les fichiers

**Propriétaire :** `packages/testkit/src/executor-background-helper.test.ts`, au niveau du vrai executor et du lifecycle, avec ordinateur sur volumes et modèle émulé.

- [ ] Étendre le test existant `starts a user turn for a message sent during the helper, which the helper never reads` avec un computer sur volumes et le vrai lifecycle. Aujourd'hui, ce test relâche le helper avant d'exécuter le second run : inverser cet ordre et vérifier la réponse persistée avant de relâcher le helper, puis le rapport et sa livraison. Garder la synchronisation par promesses.
- [ ] Étendre le scénario d'annulation existant : destruction du helper momentanément impossible, un autre run du bot complète néanmoins sa réponse ; le nettoyage peut ensuite aboutir. Le test de l'étape 2 reste l'unique propriétaire de la protection de son remplacement.
- [ ] Ne pas modifier les instructions de profil ni `screensByPath` : les montages sont conservés. Réutiliser les tests existants de captures et d'outils ordinateur pour la non-régression.
- [ ] Conserver le test web existant de rapport spontané. Ajouter un E2E seulement si un comportement UI nouveau ne peut pas être prouvé par le test d'intégration ; le runtime web scripté ne prouve pas la concurrence de deux vrais workers.

Vérification ciblée :

```sh
pnpm exec vitest run packages/testkit/src/executor-background-helper.test.ts packages/testkit/src/runtime-worker-routing.test.ts packages/testkit/src/runtime-worker-computer.test.ts packages/testkit/src/runtime-worker-subagent.test.ts
```

Résultat attendu : réponse avant résolution du helper, fichiers persistants partagés dans les deux sens, rapport livré une fois, aucune régression du navigateur ou des captures.

## Étape 4 : supprimer le schéma obsolète et valider la livraison

- [ ] Créer une nouvelle migration supprimant la FK, l'index et la colonne `volumes.writerAttemptId`, puis retirer les deux relations Prisma. Ne pas modifier les migrations historiques.
- [ ] Régénérer Prisma. Vérifier par recherche qu'aucun code actif ne référence `writerAttemptId`, `writtenVolumes`, `VolumeBusyError`, `takesWriterLease` ou `writersBlocking`. Les migrations historiques restent présentes.
- [ ] Tester la migration sur une base de test issue du schéma initial, puis sur une base vierge. Vérifier que les volumes et tentatives sont conservés.
- [ ] Ajouter une entrée Fixed au changelog pour la réponse pendant le travail d'un helper, sur web, desktop et mobile, datée du jour de livraison.
- [ ] Exécuter le skill `test-audit`, les suites ciblées, les vérifications TypeScript des packages modifiés, Biome et `git diff --check`.
- [ ] Exécuter `pnpm test:e2e:affected` avant le push ; laisser le sélecteur lancer toute la suite s'il le demande. Joindre les captures existantes desktop et 390×844 à titre d'illustration, conformément à AGENTS.md ; elles ne prouvent pas la concurrence des workers. Aucun code natif iOS n'est changé ; le test d'intégration prouve le comportement backend commun.
- [ ] Relire le diff et les résultats de tests avant de déclarer terminé. Distinguer une défaillance d'infrastructure de test d'une régression démontrée, sans la masquer par des relances.

**Déploiement :** appliquer la migration au redémarrage, une fois les anciens processus qui lisent la colonne arrêtés. Pas de rolling mixte. Les VM restent suivies par leurs tentatives ; il n'est pas nécessaire d'attendre leur destruction pour supprimer la colonne. Aucun déploiement n'est autorisé par ce plan seul.

## Revue indépendante

Relecture réalisée par **Claude Opus 5.5**, selon les instructions du rôle `founding-engineer`. Verdict : **simplifier, mais l'approche est la bonne**. Revue du plan et du code en lecture seule ; aucun test exécuté par le reviewer.

- **Accepté : conserver le garde du launcher.** Vérification complémentaire : le claim modifie bien `runs` dans `executor.ts`, puis `start` vérifie le fence sous verrou de cette ligne. Le déplacement du garde et le nouveau test de course par run sont retirés. Les erreurs Busy/Unavailable existantes restent inchangées.
- **Accepté : verrouiller les réservations dans les deux bascules.** Le plan précise maintenant les lignes verrouillées, l'horloge base et la couverture des marqueurs attendus. Aucun nouveau compteur dans ces deux chemins.
- **Accepté : supprimer `volume_busy`.** Les deux autres codes existants sont réutilisés pour tous les scopes ; pas de renommage supplémentaire.
- **Accepté : simplifier les tests.** Les cas existants sont étendus ou inversés. Retrait du test d'aller-retour de fichiers sur provider émulé et de la double variation de profil ; les montages et le comportement de réponse ont chacun leur preuve propriétaire.
- **Accepté : alléger le déploiement.** Arrêt des anciens processus avant migration ; pas d'attente de destruction de toutes les VM ni de procédure de retour arrière ajoutée.
- **Accepté : commande PostgreSQL explicite.** Utiliser `pnpm test:integration`.
- **Partiellement accepté : captures UI.** Elles ne prouvent pas la correction du lifecycle. Elles restent jointes comme illustrations parce que les instructions du dépôt les demandent pour un résultat observable ; aucun nouveau test UI n'est ajouté pour une couverture artificielle.

Aucune objection de conception laissée ouverte. L'implémentation et la validation restent à effectuer après la revue humaine du plan.
