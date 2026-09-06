# 05: Montages read-only des skills dans les sandboxes Docker

**What to build:** Un computer Docker démarré pour un bot voit les skills de l'utilisateur sous `/skills/user` et les skills marketplace du space sous `/skills/marketplaces`, en lecture seule. Le supervisor calcule les deux binds à partir de `{ spaceId, userId }` + `dataDir` (jamais d'un chemin envoyé par le client), traduit via le montage `dataDir` du conteneur supervisor. Un conteneur existant dont les binds ne contiennent pas ces montages est recréé au lieu d'être repris. L'adapter docker envoie `userId` ; le worker crée les deux dossiers avant `provision` pour que Docker ne les crée pas root.

**Décisions :** jamais tout `DATA_DIR/skills` (design Q10). Autres providers (e2b, daytona, box, desktop, fake, none) inchangés.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Test spec conteneur : binds = home + deux binds skills `:ro`
- [x] Test helper de calcul des binds ; `spaceId`/`userId` validés comme segments de chemin sûrs
- [x] Reprise d'un conteneur existant uniquement si image/network/user **et** binds skills correspondent
- [x] Adapter docker envoie `userId` ; worker `mkdir -p` des dossiers skills user + marketplaces avant provision ; tests supervisor (`vitest`, `tsc --noEmit`) et adapters verts
