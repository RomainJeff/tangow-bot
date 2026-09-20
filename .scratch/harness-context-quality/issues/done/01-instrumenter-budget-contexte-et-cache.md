# 01: Instrumenter le budget contexte et le cache par run

**What to build:** Chaque run d'agent laisse une trace chiffrée de ce qu'il a envoyé au modèle : tokens estimés pour les instructions système, pour les schémas d'outils, pour l'historique retenu, nombre de messages retenus vs disponibles, et si la fenêtre a été coupée par budget tokens ou par le fallback en nombre de messages. La trace remonte aussi les compteurs de cache du provider (`cacheRead` / `cacheWrite`) déjà exposés par le runtime pi-ai à côté des tokens input/output.

Sans ce ticket, aucune des optimisations suivantes n'est observable : on ne saurait pas si le préfixe système est servi depuis le cache, ni si la fenêtre d'historique est sur- ou sous-remplie. C'est le ticket qui rend les autres mesurables, pas une optimisation en soi.

Estimation des tokens : `ceil(chars / 4)`, la même heuristique que la compaction pi. Pas de tokenizer, pas de dépendance nouvelle.

**Blocked by:** None (can start immediately)

**Status:** done — mergé en `cb407626`

- [ ] Chaque run logue : tokens estimés instructions, tokens estimés schémas d'outils, tokens estimés historique, messages retenus / disponibles, mode de sélection de fenêtre (tokens ou fallback count)
- [ ] Les compteurs `cacheRead` / `cacheWrite` du provider sont propagés jusqu'au log de run quand le provider les fournit, absents sinon (jamais de zéro inventé)
- [ ] Aucun contenu de message, de mémoire ou d'outil dans le log — uniquement des compteurs
- [ ] Le log n'ajoute aucun appel réseau ni aucune latence perceptible
- [ ] Test déterministe offline sur l'estimation et le mode de sélection
