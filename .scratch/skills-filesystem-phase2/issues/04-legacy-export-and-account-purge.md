# 04: Export des skills existantes vers le disque au boot + purge à la suppression de compte

**What to build:** Au démarrage de l'API, chaque row encore présente dans `agent_skills` est écrite dans le store (ticket 01) au bon `spaceId/userId` puis supprimée de la table ; un log indique le nombre exporté quand il est > 0. Idempotent : un crash entre écriture et suppression réécrit simplement le même fichier au boot suivant ; un second boot exporte 0. Toutes les rows sont exportées quelle que soit leur `source`. La table et la colonne `content` restent dans le schéma Prisma cette phase (drop en phase 3 : `prisma migrate deploy` tourne avant le boot dans compose, un drop dans la même release perdrait les données). Le worker n'exporte rien (volume `/data` partagé). À la suppression d'un compte, les dossiers `skills/user/*/<userId>` disparaissent avec le reste des données user.

**Blocked by:** 01 (store filesystem)

**Status:** ready-for-agent

- [ ] Fonction d'export testée : 2 rows sur 2 owners → 2 fichiers au bon endroit, rows supprimées, second appel retourne 0
- [ ] Appelée au boot de l'API après création du client Prisma, avant le router ; log avec `count` si > 0
- [ ] Hook de suppression de compte supprime les skills de l'utilisateur dans tous les spaces
- [ ] Schéma Prisma inchangé (modèle `AgentSkill` toujours présent), aucune migration
- [ ] Tests API, `check`, biome verts ; tests testkit qui bootent `createApp` toujours verts (ou « non exécuté, Docker absent » noté)
