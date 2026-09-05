# 07: e2e + intégration finale

**What to build:** Le tout est vérifié sur `main` : un e2e Playwright ouvre le panneau Skills, vérifie les trois onglets, qu'une URL non GitHub est refusée avec message visible et qu'un skill créé apparaît dans Installed (aucun appel réseau GitHub). Suites unitaires core / adapters / api / contracts / web / supervisor vertes, e2e existants `skill-access`, `slash-skills`, `knowledge-panel` toujours verts. La ligne phase 3 du design doc passe en « livrée » avec le résumé des décisions.

**Blocked by:** 01, 02, 03, 04, 05, 06

**Status:** ready-for-agent

- [ ] e2e `skills-overlay` vert
- [ ] Toutes les suites listées vertes sur `main` après merge
- [ ] Design doc §5 mis à jour
