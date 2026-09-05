# 05: Validation live du SKILL.md dans l'éditeur

**What to build:** Dans le panneau Skills, pendant la saisie d'une skill (création ou édition), le contenu est validé à la volée avec le parseur de `@rakazo/core` déjà utilisé côté serveur. Frontmatter absent, `name` ou `description` manquant/trop long : le message d'erreur du parseur s'affiche sous la zone de texte et le bouton Save est désactivé. Contenu valide : rien ne change par rapport à aujourd'hui. Les skills read-only (builtins) ne sont pas concernées. Messages du parseur non traduits (mêmes messages que les erreurs API).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Erreur affichée sous le textarea dès que le draft non vide est invalide, disparaît quand il redevient valide
- [ ] Save désactivé tant que le draft est invalide (en plus des conditions actuelles : vide, inchangé, busy)
- [ ] Aucun changement pour un draft valide ni pour une skill read-only
- [ ] `check` web, tests web, biome verts ; e2e `knowledge-panel` vert
