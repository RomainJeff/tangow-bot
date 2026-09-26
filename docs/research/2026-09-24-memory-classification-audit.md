# Classification et captation : audit de l'implémentation

Date : 24 septembre 2026. Audit du code local ; recommandations, pas nouvelles capacités livrées.

## Origine des champs

Le formulaire Classification transpose la table « Objet mémoire et révisions » du [plan du 21 septembre](../plans/2026-09-21-memory-library-implementation.md). Nature (fact, decision, preference, procedure), sujets, importance, objectif/résultat clé et validité y étaient définis. Le cadrage a confondu OKF et OKR : les champs objectif/résultat clé résultent de cette erreur, et ne constituent pas une implémentation de Tolaria ni une exigence à conserver.

Le profil Context OS consulté définit neuf types : Daily, Memory, Note, Meeting, Document, Person, Project, Responsibility, Topic, ainsi que des relations belongs_to, related_to et des liens de remplacement datés. Ce sont des objets, sources et relations, pas les quatre natures de proposition du formulaire Rakazo. Le référentiel précis désigné par « Portent » reste à identifier ; ne pas en inventer une expansion ou une correspondance.

## Comportement vérifié dans le code

| Entrée | Résultat | Classification |
| --- | --- | --- |
| Création humaine | Document actif, versionné | Champs facultatifs saisis par la personne |
| Retenir un message | Texte capturé, référence message et extrait ; actif | Pas de classification inférée par la capture UI |
| Outil remember | Proposition propre au bot ; validation distincte | L'outil ne prend que content et path ; aucune classification structurée |
| Extraction après compaction | Au plus dix puces regroupées dans une proposition ; source au niveau thread | Pas de type, relations, objectif ou justification structurés par proposition individuelle |

Sources : [outil remember](../../packages/adapters/src/builtin-tools.ts), [commit canonique](../../packages/memory/src/index.ts), [extraction](../../packages/adapters/src/history-compaction.ts), [capture API](../../apps/api/src/router.ts), [bibliothèque](../../packages/memory/src/library.ts).

L'idempotence évite les doublons d'une même commande rejouée. Elle ne constitue pas une déduplication sémantique. L'extracteur demande au modèle de ne pas répéter ce qu'il connaît, mais il n'existe pas ici de rapprochement structuré ajouter/corroborer/remplacer/contredire. Le titre vient de la première ligne utile, pas d'un travail de synthèse validé.

Le rappel transmet chemin, révision et contenu ; le statut opérationnel et la nature de preuve doivent devenir explicites, distincts d'une formule « à valider » présente dans le texte. Les contrôles serveur d'éligibilité existent déjà, mais le modèle peut mal interpréter un texte historiquement périmé.

## Direction recommandée

Séparer quatre axes :

1. **Objet concerné** : rattachement à un projet, une responsabilité, un sujet ou une personne ; référentiel et relations à aligner avec Tolaria après clarification de Portent.
2. **Nature de l'énoncé** : observation, décision, préférence, procédure ou hypothèse. Une hypothèse ne devient pas un fait parce qu'elle est mémorisée.
3. **Provenance et validité** : auteur réel, source précise, extrait justificatif, dates, transformations et éventuels conflits. Une extraction ne peut pas augmenter l'autorité de la source.
4. **Accès et cycle de vie** : personnel/agent/espace, proposition/active/retirée. Le backend les impose ; le modèle ne les choisit pas librement.

OKF définit la représentation et l'échange des connaissances ; Tolaria fournit ici le profil de types et de relations. Un document ou une réunion est une source ; une décision à propos d'un projet est une connaissance dérivée. Éviter un unique menu mélangeant ces deux niveaux. Voir la [proposition Jev et regroupement à faible coût](2026-09-24-memory-jev-classification.md).

## Captation et curation proposées

Conserver la source autorisée → extraire des candidats autonomes avec citations → vérifier l'appui sur la source → proposer les rattachements → rechercher doublons et contradictions → présenter un changement précis à accepter → versionner → rappeler avec provenance → réexaminer après changement ou expiration.

Déclencheurs candidats : demande explicite de retenir, correction humaine, décision confirmée, fin d'un travail utile. La saturation du contexte peut déclencher une compaction technique, mais ne doit pas être l'unique horloge de l'apprentissage durable. Éviter une proposition à chaque tour sans signal.

Une observation provisoire peut alimenter la continuité de la conversation sous les mêmes droits. Elle ne devient pas automatiquement une règle durable, une permission ou une mémoire d'équipe. Aucun regroupement ne doit étendre les audiences ou supprimer les sources d'origine.

UI cible : contenu proposé, rattachement suggéré et source à la demande ; actions **Garder**, **Modifier**, **Ignorer**. Les candidats sans classement fiable restent non classés. Un conflit ouvre un choix explicite ; le système ne sélectionne pas automatiquement la version la plus récente comme vérité.

Évaluer séparément fidélité à la source, couverture des informations utiles, exactitude du rattachement, doublons, contradictions, effort humain, utilité sur une tâche ultérieure et résistance aux contaminations. Les 73 fiches de démonstration testent surtout l'interface ; leur nombre ne prouve pas la qualité de l'extraction automatique.

Voir la [revue de littérature](2026-09-24-memory-capture-literature.md) pour les mécanismes étudiés et leurs limites.
