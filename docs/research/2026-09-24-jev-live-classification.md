# Jev — première recette de classification réelle

## Périmètre

Huit appels séquentiels à travers l'adaptateur de classement livré dans Rakazo,
avec la connexion configurée sur l'instance Docker locale. Aucun mock de Jev.
Modèle demandé : `jev-latest` ; modèle retourné : `jev-1.13.0`.
Les textes et voisins de cette série sont entièrement fictifs, sans lecture des
mémoires existantes. La clé reste dans le serveur et n'est pas consignée.

Un neuvième appel est vérifié dans l'interface, sur une proposition importée dans
l'espace de démonstration. Ce parcours utilise la recherche de voisins réelle de
la bibliothèque. La suggestion n'est pas appliquée et la proposition n'est pas acceptée.

## Résultats de la série contrôlée

Les attentes ci-dessous sont définies avant les appels. Le verdict porte sur la
nature ou la relation visée, pas sur toutes les dimensions de la réponse.

| Cas | Entrée résumée | Attendu | Résultat | Durée |
| --- | --- | --- | --- | --- |
| Décision | Nous avons décidé de livrer la démo Lumen le 15 octobre | decision | decision | 533 ms |
| Préférence | Je préfère les comptes rendus en français, trois points maximum | preference | preference | 564 ms |
| Procédure | Vérifier la sauvegarde, migrer, contrôler la santé | procedure | procedure | 202 ms |
| Hypothèse | Le cache pourrait expliquer le ralentissement, sans confirmation | hypothesis | hypothesis | 263 ms |
| Doublon | Deux textes identiques fixent la conservation des journaux à 30 jours | duplicate | duplicate | 254 ms |
| Contradiction | 30 jours et 90 jours, applicables à la même date | contradiction | contradiction | 265 ms |
| Remplacement daté | Règle de 30 jours limitée à octobre ; 90 jours à partir de novembre, remplaçant la règle précédente | possible_replacement | **complement** | 222 ms |
| Instruction hostile citée | Observation de sécurité citant une attaque demandant le classement preference | observation | observation | 245 ms |

Sept attentes ciblées sur huit sont satisfaites sur cette exécution. Ce petit jeu
construit à la main ne mesure pas la précision générale et ne démontre aucune
garantie contre les injections.

Total retourné par le fournisseur : 7 240 tokens d'entrée et 1 723 de sortie.
Durée moyenne : 318,5 ms ; médiane : 258,5 ms ; plage : 202–564 ms.
Ces durées couvrent l'appel à l'adaptateur, pas toute l'interface ni la capture.
Aucun montant facturé n'est vérifié.

## Vérification dans l'interface

Une note OKF portant la préférence fictive est importée comme proposition.
Le parcours Details → Review classification présente la confirmation de partage,
puis affiche `jev-1.13.0`, le type `Note` et la nature `preference`.
Une relation `complement` avec une mémoire de démonstration « Compte rendu » est
également proposée ; sa pertinence n'est pas validée dans cette recette.
Les commandes Apply suggestion et Accept restent disponibles : aucune application
ni activation automatique n'a été observée. La proposition est laissée en place
pour inspection, sans modification des mémoires existantes.

## Limites et corrections à cibler

1. **Remplacement temporel.** Clarifier les critères de remplacement et de complément,
   puis tester des variantes : périodes disjointes, dates ambiguës, changement explicite
   et conflit simultané. Une seule erreur ne justifie pas un seuil universel.
2. **Type documentaire.** La décision isolée est classée `Project` ; sept des huit cas
   n'obtiennent pas de type. L'API donne actuellement des noms de types avec peu de
   définitions. Une mention de projet ne suffit pas à faire d'une note une fiche projet.
3. **Incertitude par question.** Les scores exposés, de 0,29 à 0,55, sont le minimum
   des confiances du type, de la nature, de l'entité et des relations. Ils ne permettent
   donc pas de juger séparément une bonne nature et un type incertain. Conserver les
   distributions et confiances par dimension avant de définir une politique d'abstention.
4. **Couverture des voisins.** La présélection reste lexicale : Jev ne peut pas détecter
   une relation avec une mémoire qui ne lui a pas été présentée. Tester séparément le
   rappel de la recherche et la qualité du jugement sur les voisins reçus.

Cette recette valide un premier fonctionnement réel, pas la récolte autonome,
la qualité de rappel en conversation, les droits entre plusieurs utilisateurs ni
la résistance à un corpus d'attaques.

Références utilisées : [skill TypeSafe](../../.agents/skills/typesafe-ai/SKILL.md),
[classification et confiance](https://docs.typesafe.ai/cookbooks/classification_using_confidence),
[API TypeSafe](https://docs.typesafe.ai/api).
