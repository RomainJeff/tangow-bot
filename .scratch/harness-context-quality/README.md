# Qualité et pertinence du contexte (harness)

Issu d'un audit du stack de messages envoyé au modèle : prompt système, historique, compaction, mémoire, outils, événements inter-bots. Chaque ticket est ancré sur un comportement constaté dans le code, pas sur une bonne pratique générique — voir `NON-GOALS.md` pour ce qui a été écarté et pourquoi.

Les tickets livrés sont archivés dans `issues/done/`, avec le sha du merge dans leur statut. `issues/` ne garde que ce qui reste ouvert.

## Ouverts

| # | Titre | Bloqué par | Statut |
|---|---|---|---|
| 08 | Décision — simplifier le fallback de fenêtre en nombre de messages | — (03 mergé) | needs-decision |
| 09 | Décision — borner le nombre d'outils de connecteurs exposés | — (01 mergé) | needs-decision |
| 12 | Décision — qui possède le run de compaction d'un thread de groupe | — (11 mergé) | needs-decision |
| 14 | Remplacer la garde de contiguïté read-side par un comptage | — | ready-for-agent |
| 15 | Débloquer la reconstruction de couverture legacy sur un thread rembobiné | — | ready-for-agent |
| 16 | Rendre les compteurs de tokens lisibles dans les logs | — | needs-decision |

08, 09 et 12 sont des décisions produit ou des arbitrages qui demandent des chiffres, pas du code à écrire. 16 a son correctif déjà rédigé dans le ticket, volontairement non appliqué. 14 et 15 sortent de l'inspection du déploiement et sont indépendants du reste.

## Livrés (`issues/done/`)

| # | Titre | Merge |
|---|---|---|
| 01 | Instrumenter le budget contexte et le cache par run | `cb407626` |
| 02 | Rendre le préfixe système stable et cacheable | `c88ba4b6` |
| 03 | Renseigner la fenêtre de contexte du modèle depuis le catalogue | `6c114898` |
| 04 | Calculer le budget hors-historique au lieu de le supposer | `b3c55d11` |
| 05 | Conserver les traces d'outils d'un tour à l'autre | `815f8372` |
| 06 | Ne plus faire passer les messages de bots pairs pour les siens | `f8333a95` |
| 07 | Rappeler la mémoire sémantique dès le premier tour | `9e866f88` |
| 10 | Attribuer les tours des bots membres d'un groupe | `88176952` |
| 11 | Garder l'attribution des membres dans le résumé de compaction | `ec33b9a6` |
| 13 | Rendre les tours passés du bot en messages `assistant` natifs | `6d2a85d5` |

Hors ticket, sur la même branche : un correctif de compaction (`0757d097`). Un thread dont un message a été édité pouvait cesser de se compacter définitivement — le rembobinage laisse un trou permanent dans les seq, que la garde de contiguïté côté écriture prenait pour une corruption. Bug pré-existant, trouvé en inspectant un déploiement de la branche, d'où les tickets 14 et 15.

## Ce qui reste non mesurable

Qualité des résumés de compaction, effet de la position des règles de sécurité, effet du marquage des rôles sur la voix de l'assistant. Ces trois-là demandent un juge humain ou un juge modèle ; aucun ticket ne promet de gain chiffré dessus.
