# OKF, classification et regroupement à faible coût

Recherche du 24 septembre 2026. Proposition d'architecture, sans intégration ni benchmark Rakazo de Jev. Complète la [revue de littérature](2026-09-24-memory-capture-literature.md).

## Corriger le modèle

La confusion OKF/OKR explique les champs Objective et Key result. Ils ne traduisent pas la structure demandée. [OKF](https://github.com/GoogleCloudPlatform/open-knowledge-format/blob/main/SPEC.md) définit des documents Markdown avec métadonnées YAML ; type est le seul champ toujours obligatoire et les valeurs ne sont pas une taxonomie universelle. Le profil Tolaria consulté utilise neuf types (Daily, Memory, Note, Meeting, Document, Person, Project, Responsibility, Topic) et des relations explicites. Il référence OKF v0.1 ; la spécification publique consultée est v0.2. Ne pas changer implicitement de profil à l'occasion de cette correction.

Distinguer format d'échange, type de document, nature d'une affirmation, entités concernées, rapprochements thématiques et droits. Une décision sur un projet n'est pas elle-même un projet ; un groupe thématique ne définit aucune audience.

## Ce que Jev apporte

La [documentation officielle](https://docs.typesafe.ai/introduction) décrit un modèle de décisions typées : Choice sélectionne une option, Score applique une échelle définie, Noul estime une réponse affirmative. Choice et Score exposent aussi une confiance. Il ne génère pas de texte libre : conserver un extracteur distinct pour reformuler une mémoire, produire un titre ou une synthèse.

Deux exemples officiels sont particulièrement pertinents : [classification hiérarchique](https://docs.typesafe.ai/cookbooks/hierarchical_classification), avec exploration de plusieurs branches, et [alignement d'entités](https://docs.typesafe.ai/cookbooks/entity_alignment), où un premier filtre présélectionne des paires avant que le modèle juge leur identité. Ce sont des recettes du fournisseur, pas une mesure de précision sur des mémoires Rakazo.

La [confiance](https://docs.typesafe.ai/confidence) ne constitue pas une preuve de vérité : les seuils doivent être évalués sur le domaine. Une [prépublication du 22 septembre 2026](https://arxiv.org/abs/2609.26758) observe, dans ses expériences sur Jev et deux autres modèles, une sensibilité à l'association entre noms d'options et définitions, alors même que les sorties respectent toujours le schéma. Ajouter des tests de reformulation, de noms et d'ordre des options ; ne pas extrapoler cette expérience en taux d'erreur produit.

## Cascade proposée

1. Capturer une source autorisée et sa version ; conserver auteur et passage justificatif. Extraire des unités autonomes sans perdre conditions ou négations. Réutiliser les sources déjà connues plutôt que redemander au modèle leur identité.
2. Éliminer les répétitions exactes par code. Rechercher des voisins par index lexical et/ou embeddings, dans le périmètre autorisé avant tout envoi éventuel à un fournisseur. Les embeddings sont calculés une fois par version.
3. Faire juger à Jev des questions bornées : nature parmi catégories définies et indéterminé ; rattachement parmi identifiants présélectionnés et aucun ; relation à un voisin parmi doublon, complément, contradiction, remplacement possible, sans rapport. Tester ces questions séparément puis composer leurs résultats côté serveur. La relation de remplacement doit tenir compte des dates et de l'autorité, pas simplement de la récence.
4. Affecter automatiquement des métadonnées proposées réversibles si la précision mesurée le justifie. En cas d'ambiguïté, conserver non classé ou solliciter un modèle plus capable/la personne. Classer n'active pas la mémoire et ne la publie pas à une équipe.
5. Former des groupes thématiques à partir des liens, progressivement. Comparer chaque arrivée à quelques voisins, pas chaque document à tous les autres. La similarité n'est pas transitive : deux liens ne suffisent pas à fusionner trois assertions. Autoriser plusieurs rattachements et des éléments isolés ; garder les clusters comme vues dérivées reconstruisibles.
6. Réserver les synthèses génératives et propositions de fusion aux groupes qui en ont besoin, avec différences et sources. Conserver les originaux selon rétention et faire suivre révocation/retrait dans les dérivés. Les accès sont réévalués à chaque lecture ; aucun résumé commun ne mélange des éléments de droits incompatibles.

Pour un premier produit, les voisins et rattachements explicites suffisent : éviter d'ajouter un moteur global de communautés avant d'avoir mesuré ce que les utilisateurs retrouvent mieux. Jev reste un adaptateur optionnel derrière le même contrat de classification qu'un modèle local ou un LLM à sortie structurée. Le backend possède les règles d'accès et de publication.

## Budget et évaluation

Le [tarif publié](https://typesafe.ai/blog/introducing-system-one-models-and-jev) est de 0,042 dollar par million de tokens entrants, sorties gratuites. À ce tarif, 20 millions de tokens entrants facturés coûtent 0,84 dollar. Ce calcul illustratif n'est pas le budget total de 10 000 mémoires : questions, voisins, extraction, embeddings, reprises et orchestration modifient le volume réel. La latence annoncée de 70–500 ms est celle du fournisseur, non mesurée dans Rakazo.

Réduire les coûts par déclencheurs utiles, traitement différé, cache par contenu/version de schéma/modèle, limitation du nombre de voisins et escalade des seuls cas ambigus. Enregistrer l'usage réellement facturé.

Comparer sur un corpus annoté la recherche seule, recherche + petit modèle structuré et recherche + Jev. Mesurer précision par classe, abstention et couverture, rattachements erronés, fausses fusions, fidélité aux sources, temps de correction, coût par mémoire acceptée et réussite de tâches futures. Inclure français, négations, changements temporels, instructions injectées, faux accords humains et documents contradictoires. Séparer calibration et jeu de test. Ne pas choisir un seuil universel de confiance.

## Sécurité et UX

Jev peut aider à détecter des anomalies, mais ne doit jamais décider de l'autorité d'une source ni accorder des permissions. Une page externe reste une page externe après classification, répétition ou synthèse. Les métadonnées de provenance viennent du système, pas du texte analysé. Aucune architecture de modèles ne garantit l'absence absolue de poisoning ; les limites doivent être testées de l'écriture jusqu'à l'action.

Dans la fiche, montrer contenu Markdown, rattachement proposé et source accessible. Garder/Modifier/Ignorer restent les actions principales. Les scores internes et le formulaire complet ne sont pas nécessaires à la revue ordinaire. La classification automatique retire du travail à la personne ; elle n'ajoute pas un formulaire.
