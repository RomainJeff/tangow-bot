# 02: Téléchargement GitHub sûr + store FS des marketplaces

**What to build:** Le package adapters sait, sans toucher à la DB : (1) parser une URL `https://github.com/<owner>/<repo>`, résoudre un ref en sha via l'API GitHub, streamer le tarball codeload avec cap 50 MB et extraction sans symlinks/`..` (dépendance directe `tar`, déjà dans le lockfile) ; (2) lire un manifest `.claude-plugin/marketplace.json`, installer uniquement `<plugin>/skills/**` sous `skills/marketplaces/<spaceId>/<marketplace>/plugins/<plugin>/skills/<slug>/` (SKILL.md > 100k → plugin entier refusé ; commands/agents/hooks/.mcp.json ignorés + loggés), lister ces skills comme records `mkt:<marketplace>/<plugin>/<slug>` `source: plugin` read-only, et calculer un diff fichier à fichier (ajouté / supprimé / modifié, tailles, contenu texte avant/après) entre deux arbres `skills/`. Helpers core : `marketplaceSkillKey`, `isMarketplaceSkillKey`, `defaultSkillAvailability` (`mkt:` → `selected`).

**Décisions :** GitHub public uniquement (Q6), plugins à source non relative listés « non supporté ». Noms marketplace/plugin/skill lowercase `^[a-z0-9][a-z0-9._-]{0,63}$`.

**Blocked by:** None (can start immediately)

**Status:** done

- [x] Tests unitaires avec fetch factice : URL non GitHub refusée, sha résolu via `Accept: application/vnd.github.sha`, tarball extrait sans le top dir ni les symlinks, cap d'octets déclenche une erreur
- [x] Tests store : manifest parsé (lowercase, sources non supportées flaggées), install copie seulement `skills/`, SKILL.md > 100k rejette le plugin, remove, diff ordonné par chemin
- [x] Helpers core testés ; store + tarball ré-exportés depuis l'index adapters ; check + biome verts
