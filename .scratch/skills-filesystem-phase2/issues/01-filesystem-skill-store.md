# 01: Store filesystem des skills user (prefactoring)

**What to build:** Un module unique dans `@rakazo/adapters` qui devient la source de vérité du contenu des skills user : `DATA_DIR/skills/user/<spaceId>/<userId>/<dir>/SKILL.md`. Il expose la racine par owner, le nom de dossier dérivé de la skillKey (`encodeURIComponent(lower(trim(name)))`, garde `.`/`..`), la liste (readdir → parse frontmatter, fichier invalide ignoré avec `console.warn`, dates = mtime), l'écriture en mode `create` (flag `wx`, EEXIST = doublon) ou `replace` (tmp + rename atomique), la suppression d'une skill, et la purge de toutes les skills d'un userId à travers les spaces. Exporté depuis l'index du package. Aucun consommateur branché dans ce ticket : c'est le socle des tickets 02, 03, 04.

Décisions (plan phase 2, « Décisions tranchées ») : id d'une skill = `userSkillKey(name)` ; pas de cache mtime ; `createdAt = updatedAt = mtime` ; le `name` affiché vient du frontmatter, jamais du dossier.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Racine `skills/user/<spaceId>/<userId>` sous `DATA_DIR`
- [ ] Nom de dossier bijectif, FS-safe, identique pour `Daily Standup` / ` daily standup ` ; `.` et `..` encodés
- [ ] Liste : racine absente → `[]` ; dossiers sans SKILL.md, fichiers parasites et frontmatter invalide ignorés ; tri par nom ; entrées `{id, name, description, content, source:"user", readOnly:false, createdAt, updatedAt}`
- [ ] Création refuse un doublon case-insensitive (erreur reconnaissable EEXIST)
- [ ] Remplacement atomique (jamais de SKILL.md tronqué)
- [ ] Suppression d'une skill ; purge par userId sur tous les spaces, no-op si rien
- [ ] Tests unitaires en tmpdir couvrant tout ça ; `check` + biome verts sur les fichiers touchés
