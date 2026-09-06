# 03: RPC `marketplaces.*`

**What to build:** Un membre du space peut, via RPC : ajouter une marketplace GitHub (ref par défaut `HEAD`, sha épinglé, manifest copié sur le FS, ligne `SpaceMarketplace` créée, doublon refusé), lister ses marketplaces, voir les plugins d'une marketplace avec état installé / supporté, installer ou retirer un plugin (retrait = dossier supprimé + `SkillSetting`/`BotSkill` du préfixe `mkt:<m>/<p>/` purgés), vérifier une mise à jour (nouveau sha + diff complet des plugins installés, ou `upToDate`), l'appliquer sur un sha donné (réinstalle les plugins, met à jour le commit), et supprimer la marketplace (FS + ligne + settings).

**Décisions :** namespace `marketplaces.*` à côté de `agentSkills.*` (Q9, `skills.*` pris par TaughtSkill). checkUpdate et applyUpdate téléchargent chacun le tarball (`// ponytail:`). Fetch via `createSafeRemoteFetch`.

**Blocked by:** 01 (table SpaceMarketplace), 02 (tarball + store)

**Status:** done

- [x] Contrat zod : `SpaceMarketplace`, `MarketplacePlugin`, `MarketplaceFileChange`, `MarketplaceUpdateCheck` ; procédures list / add / remove / plugins / installPlugin / removePlugin / checkUpdate / applyUpdate
- [x] Service testé avec prisma en mémoire + fetch factice : add (ok, doublon, URL non GitHub), plugins, installPlugin (ok, non supporté), removePlugin purge les settings, checkUpdate upToDate vs changements, applyUpdate, remove
- [x] Handlers câblés dans le router, accès limité au space de l'acteur ; check + tests API verts
