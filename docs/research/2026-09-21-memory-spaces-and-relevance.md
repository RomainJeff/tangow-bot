# Espaces de mémoire, consolidation et pertinence

Proposition de conception au 21 septembre 2026. Aucun de ces contrats n'est présenté comme déjà implémenté dans Rakazo. Les exemples de la maquette sont fictifs ; son classement est simulé, pas produit par un moteur de recherche. Les références Context OS ont été fournies pour analyse, sans exécution de leurs rituels.

## Ce que Context OS apporte

Le contrat `dream/references/candidate-pipeline.md` distingue collecte de signaux durables, regroupement des récurrences, puis évaluation des candidats. Ses cinq dimensions sont durabilité, preuves, conséquence, nouveauté et clarté d'attribution ou de conflit. Le score facilite un tri humain ; il n'établit ni la vérité ni l'utilité pour une requête particulière. Une décision explicite peut valoir dès sa première occurrence. Deux Daily distincts établissent une récurrence documentaire, pas nécessairement deux preuves indépendantes.

La destination canonique la plus étroite évite les copies : projet, personne, responsabilité ou sujet. Les contradictions restent séparées ; une révision ferme une période de validité. Le cadrage historique sur l'observabilité proposait aussi un manifeste du contexte transmis et des questions de référence. Ce sont des propositions distinctes des fonctionnalités effectivement livrées et évaluées. Les fixtures de parcours ne démontrent pas la qualité générale d'un clustering.

## Quatre mémoires et un contexte temporaire

| Collection | Responsabilité | Usage |
| --- | --- | --- |
| Personnelle | La personne | Préférences et contexte personnel, accès explicite par agent et situation |
| Propre à un agent | Une personne ou équipe désignée | Expériences et connaissances rattachées à cet agent |
| Équipe | Collectif et responsables de publication | Conventions et connaissances communes |
| Projet | Responsables du projet | Décisions, contraintes et connaissances limitées à ce travail |

L'agent auteur n'est pas automatiquement propriétaire. L'audience, les contributeurs autorisés et la responsabilité sont des propriétés différentes. Un agent consulte une collection partagée par référence ; il ne recopie pas son contenu dans une mémoire indépendante.

Publier un extrait issu d'une mémoire privée est une opération distincte : proposition au périmètre choisi, avec contenu partagé exact et source expurgée, puis validation. La version publiée reste reliée à son origine. Elle ne donne pas accès au document privé et ne reçoit pas silencieusement ses modifications ultérieures.

Le contexte d'une exécution est temporaire. Il combine uniquement les éléments admissibles pour l'identité demandeuse, le mandat de l'agent et l'audience de la réponse. Les droits de l'agent seuls ne suffisent pas. Même les titres de clusters et les compteurs doivent respecter cette audience.

## Regrouper, consolider, résoudre

**Regrouper** crée une vue thématique sans modifier les faits, leur statut ni leurs droits. Un souvenir peut apparaître dans plusieurs sujets sans être copié. Des rapprochements sémantiques et d'entités proposent les groupes ; noms et rattachements restent corrigeables.

**Consolider** propose une nouvelle formulation avec sources, exceptions, conditions et périodes conservées. Une synthèse n'hérite pas automatiquement de l'approbation de ses parents. Ses restrictions initiales satisfont celles de toutes ses sources, et ses dépendances restent traçables pour les révocations.

**Résoudre** traite une incompatibilité réelle dans le même périmètre et à la même période. Ne pas fusionner une règle et son exception ni confondre changement de situation et contradiction.

## Juger la pertinence

Séparer quatre décisions : vaut-il la peine de conserver cette information ; est-elle admissible pour cette exécution ; apporte-t-elle une information utile à la tâche ; quelle confiance accorder à son contenu. Un score ne doit pas autoriser l'accès, une action ou une publication.

Sélection proposée :

1. Filtrer droits, état et versions révoquées avant recherche. Choisir le régime temporel selon la question : état actuel ou période historique ; un fait remplacé peut être utile à une question sur le passé.
2. Chercher des candidats par mots, sens, entités, projet et date. La proximité sémantique ne prouve pas l'utilité.
3. Examiner les candidats avec l'objectif, les obligations et l'état de travail. Montrer au sélecteur les contenus pertinents, pas seulement les noms d'outils ou les titres.
4. Construire un ensemble qui couvre les besoins sans redondance, sous budget de contexte. Conserver les exceptions et contre-preuves. Une origine copiée dix fois ne devient pas dix confirmations.
5. Laisser l'agent rechercher davantage de preuves à la demande, avec budgets et droits réévalués. Préserver des références récupérables aux éléments retirés du contexte actif.

Le chargement hybride — petit socle initial et recherche progressive — est une pratique documentée. Il échange du coût d'exploration contre une réduction du contexte inutile. [Anthropic, context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents).

La compaction d'une conversation répond à la continuité du travail, pas à la publication d'une vérité durable. Les critiques et expériences Jev/Hermes sont détaillées dans la [note dédiée](2026-09-21-agentic-compaction-relevance.md).

## Interface proposée

Trois entrées : mémoire de l'agent avec collections partagées accessibles ; bibliothèque de l'équipe ou du projet regroupée par sujet ; contexte transmis pour une tâche. La dernière décrit ce que le système a fourni, pas ce qui a causalement influencé la réponse. La maquette montre une simulation explicitement nommée.

La revue devient une vue locale au périmètre concerné, visible lorsqu'il y a des propositions. Le détail présente preuve, origine, période et responsabilité. La consolidation montre ce qui est réuni et ce qui restera accessible. Les réglages des fournisseurs et de stockage restent secondaires.

## Évaluation proposée

Figer les états mémoire et séparer chronologiquement apprentissage et tâches de test. Comparer absence de mémoire, sélection actuelle, règles simples et nouvelle sélection à conditions comparables. Mesurer couverture des faits nécessaires, omissions critiques, pertinence du contexte, exactitude finale, abstention, divulgations, répétitions d'actions, coût total et latence. Inclure ingestion, consolidation, récupération et comportement du cache.

Retirer ponctuellement un souvenir sur des replays permet d'estimer sa contribution, sans transformer une citation ou une fréquence d'usage en preuve d'utilité. Tester aussi les faits rares, anciens mais encore valides, les corrections, questions historiques, révocations et copies empoisonnées. [LongMemEval](https://arxiv.org/abs/2410.10813), [défenses et limites](2026-09-21-memory-poisoning-defenses.md).

Validation de cette proposition : contre-analyse indépendante et vérification statique de la maquette. Aucun test de produit connecté, benchmark de classement ou contrôle de rendu navigateur n'a été réalisé.
