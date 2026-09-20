# Qualité et pertinence du contexte (harness)

Issu d'un audit du stack de messages envoyé au modèle : prompt système, historique, compaction, mémoire, outils, événements inter-bots. Chaque ticket est ancré sur un comportement constaté dans le code, pas sur une bonne pratique générique — voir `NON-GOALS.md` pour ce qui a été écarté et pourquoi.

## Tickets

| # | Titre | Bloqué par | Statut |
|---|---|---|---|
| 01 | Instrumenter le budget contexte et le cache par run | — | ready-for-agent |
| 02 | Rendre le préfixe système stable et cacheable | — | ready-for-agent |
| 03 | Renseigner la fenêtre de contexte du modèle depuis le catalogue | — | ready-for-agent |
| 04 | Calculer le budget hors-historique au lieu de le supposer | 03 | ready-for-agent |
| 05 | Conserver les traces d'outils d'un tour à l'autre | — | ready-for-agent |
| 06 | Ne plus faire passer les messages de bots pairs pour les siens | — | ready-for-agent |
| 07 | Rappeler la mémoire sémantique dès le premier tour | — | ready-for-agent |
| 08 | Décision — simplifier le fallback de fenêtre | 03 | needs-decision |
| 09 | Décision — borner les outils de connecteurs exposés | 01 | needs-decision |

## Ordre conseillé

01 d'abord : sans mesure, les gains des autres tickets sont invérifiables. Puis 02, 03→04, 05, 06, 07 en parallèle selon les disponibilités. 08 et 09 se tranchent avec les chiffres produits par 01 et 03.

## Ce qui reste non mesurable

Qualité des résumés de compaction, effet de la position des règles de sécurité, effet du marquage des rôles sur la voix de l'assistant. Ces trois-là demandent un juge humain ou un juge modèle ; aucun ticket ne promet de gain chiffré dessus.
