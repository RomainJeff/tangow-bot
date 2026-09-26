# Captation et curation de la mémoire des agents

Recherche du 24 septembre 2026. Sources primaires uniquement. Cette note propose une direction produit ; elle ne décrit pas des mécanismes déjà implémentés ni une validation de sécurité de Rakazo.

## Recommandation

Séparer **source**, **proposition**, **mémoire validée** et **synthèse**. Capter des éléments atomiques avec leurs preuves, puis proposer leur classement et leurs liens. Une synthèse ne doit jamais devenir une preuve de ses propres affirmations. La compaction de conversation n'est ni une validation ni une méthode suffisante de constitution de la mémoire durable.

Le bon objet de revue est « voici ce que j'ai retenu, voici d'où cela vient, voici ce que cela remplacerait ». Un formulaire de métadonnées rempli à la main ne résout pas la qualité de captation.

## Ce que montrent les travaux

| Source primaire | Mécanisme étudié | Conséquence pour Rakazo et limite |
|---|---|---|
| [MemGPT, octobre 2023](https://arxiv.org/abs/2310.08560) | Gestion d'une hiérarchie de mémoire par le modèle, avec transferts entre contexte et stockage externe. | Séparer mémoire de travail et stockage durable. Cette architecture ne démontre pas la véracité de ce qui est écrit. |
| [Mem0, avril 2025, §2](https://arxiv.org/html/2504.19413v1) | Extraction de candidats depuis un échange, les messages récents et un résumé ; comparaison avec les souvenirs proches ; décisions d'ajout, modification, suppression ou absence de changement. | Reprendre la comparaison avant écriture, mais présenter les modifications comme propositions révisables. Les gains annoncés sont mesurés sur LoCoMo par les auteurs ; les questions adversariales d'abstention sont exclues de leur évaluation. Ce n'est pas une preuve anti-poisoning. |
| [A-MEM, février 2025](https://arxiv.org/abs/2502.12110) | Notes avec description, mots-clés, tags ; génération de liens ; évolution d'attributs des notes antérieures lors des nouveaux apports. | Le classement peut émerger de la captation et évoluer. Les tags et liens servent l'organisation, pas l'autorisation. Les résultats ne justifient pas de laisser un modèle réécrire silencieusement des décisions validées. |
| [Zep, janvier 2025](https://arxiv.org/html/2501.13956v1) | Graphe temporel associant épisodes, entités et faits évolutifs ; distinction entre temporalité des événements et ingestion. | Garder « observé à » et « valable pendant ». Un changement légitime ferme une ancienne période au lieu d'effacer le passé. Les résultats des auteurs portent sur leur architecture et leurs benchmarks. |
| [LangMem, documentation consultée le 24/09/2026](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) | Écriture pendant la conversation ou extraction différée ; mémoires sémantiques, épisodiques et procédurales ; schémas adaptés à l'application. | Combiner captation explicite et traitement différé borné. La documentation expose des possibilités, pas une comparaison contrôlée de leur sûreté. |
| [Hindsight, décembre 2025](https://arxiv.org/abs/2512.12818) | Distingue faits du monde, expériences de l'agent, résumés d'entités et croyances évolutives ; opérations de conservation, rappel et réflexion. | Distinguer observation et interprétation. Une hypothèse de l'agent ne doit pas recevoir le même statut qu'une déclaration humaine ou une observation d'outil vérifiable. Performances rapportées sur benchmarks conversationnels, pas preuve d'isolation multi-utilisateur. |
| [MemRL, janvier 2026, révision février](https://arxiv.org/abs/2601.03192) | Récompenses issues des résultats des tâches pour apprendre l'utilité des souvenirs épisodiques, au-delà de leur seule similarité. | Mesurer l'utilité à partir d'un résultat observable. La fréquence de rappel n'est pas une preuve de vérité. Transposer une récompense à un produit collaboratif exige de définir ce qu'est une réussite et qui l'évalue. |
| [Mastra Memory Extractors, 21 juillet 2026](https://mastra.ai/blog/introducing-memory-extractors) | Extraction structurée configurable dans les agents d'observation et de réflexion ; sortie exploitable par l'interface et des services. | La classification devrait être une proposition structurée produite à la captation, selon un schéma métier explicite. Fonctionnalité d'éditeur documentée, pas validation scientifique de la justesse des champs. |
| [Auto-Dreamer, mai 2026](https://arxiv.org/abs/2605.20616) | Acquisition rapide par session séparée de la consolidation entre sessions ; région source en lecture seule, parcours borné des preuves, nouveau jeu de souvenirs qui remplace l'ancien. | Bonne séparation des responsabilités : observer maintenant, proposer une consolidation ensuite. Prépublication, avec consolidateur entraîné et évaluations sur environnements de tâches ; ses gains ne se transfèrent pas automatiquement à des conversations métier. |

### Deux avertissements récents sur la consolidation

[Useful Memories Become Faulty When Continuously Updated by LLMs, mai 2026, révision du 29 août](https://arxiv.org/abs/2605.12978) observe une utilité qui augmente puis se dégrade lorsque les mémoires sont continuellement réécrites. Dans les environnements étudiés, conserver les épisodes peut concurrencer les systèmes de consolidation. Il faut donc tester le calendrier de consolidation et conserver les preuves, plutôt que supposer qu'une synthèse supplémentaire améliore toujours la mémoire. Cette prépublication n'établit pas que toute consolidation soit inutile.

[When Memory Becomes Authority, août 2026](https://arxiv.org/abs/2608.01679) étudie la perte des contraintes d'autorité pendant la consolidation : une affirmation reste, mais l'origine qui limitait son usage disparaît. Les auteurs observent ce phénomène dans 48 des 49 configurations étudiées. Leur évaluation rapporte une réduction des actions non autorisées avec des métadonnées d'autorité persistantes. Résultat circonscrit au protocole, pas garantie universelle. Une mémoire doit conserver **qui l'a dit, à quel titre et pour quel usage**, pas seulement son texte.

### Empoisonnement : le danger apparaît dès l'écriture

[MINJA, 2025](https://arxiv.org/abs/2503.03704) montre une attaque où des interactions ordinaires amènent l'agent à écrire des souvenirs malveillants, sans accès direct de l'attaquant à la base. Protéger uniquement le moteur de recherche arrive trop tard.

[Memory Poisoning Attack and Defense, janvier 2026](https://arxiv.org/abs/2601.05504) nuance la transférabilité des taux d'attaque : les souvenirs légitimes préexistants et les paramètres du système modifient les résultats. La calibration des filtres de confiance peut soit tout bloquer, soit laisser passer des attaques. Un score élevé n'est pas une preuve d'intégrité.

[FARMA / SENTINEL, juillet 2026](https://arxiv.org/abs/2607.05029) examine des traces de raisonnement falsifiées et leur renforcement autoréférentiel. Les résultats encourageants de sa défense proviennent d'un périmètre expérimental limité. Ne pas traiter « l'agent l'a déjà écrit plusieurs fois » comme corroboration indépendante ; les descendants d'une même source restent une seule origine.

## Pipeline candidat pour Rakazo

Les choix suivants sont une **recommandation de conception**, pas un consensus démontré par les publications.

1. **Observer sans promouvoir.** Trois déclencheurs : action « Retenir » de l'utilisateur, proposition explicite de l'agent, extraction différée à la clôture d'un échange ou d'une tâche. Fixer budget et périmètre. Ne pas tout extraire à chaque message. Le [traitement différé de LangMem](https://langchain-ai.github.io/langmem/guides/delayed_processing/) fournit un exemple de regroupement des traitements pour éviter les répétitions.
2. **Extraire une affirmation par candidat.** Préserver sujet, négation, condition, temporalité et auteur. Exemple : « Le lancement du projet Exemple est reporté à octobre » ; ne pas inventer une raison absente de la source. « Peut-être octobre » reste une hypothèse. Les faits reliés peuvent rester reliés sans être fusionnés dans une seule fiche impossible à valider partiellement.
3. **Joindre la preuve avant tout classement.** Identifiant et révision du message/document, passage justificatif, auteur observé, date, espace autorisé, outil ou extracteur responsable, origine primaire et dépendances. Garder la source consultable selon une politique de rétention et de droits explicite ; sa suppression doit invalider les dérivés concernés ou déclencher leur revue, sans conserver indéfiniment une copie cachée.
4. **Proposer type et rattachement.** Le schéma doit reprendre la taxonomie produit décidée, et permettre « non classé ». Distinguer type de note, entités reliées, usage et statut épistémique. Rattacher à une entité existante quand la preuve le permet. La clarification utilisateur porte sur OKF et le profil Tolaria ; les champs OKR du formulaire ne constituent pas une exigence actuelle de cette recommandation. Les étiquettes ne constituent jamais des droits d'accès.
5. **Comparer avant ajout.** Classer la relation au stock existant : nouveau, doublon, complément, contradiction, remplacement temporel. Proposer une différence lisible et les preuves associées. Les ressemblances sémantiques ne suffisent pas à conclure à un doublon.
6. **Valider l'usage durable.** Les règles et permissions sont appliquées côté serveur. La proposition reste hors du rappel actif ; une publication partagée nécessite un droit et une action explicites. Une mémoire de procédure n'accorde jamais à elle seule la permission d'exécuter une action.
7. **Consolider à froid, avec revue.** Regrouper des candidats d'un même sujet ; proposer fusion, remplacement ou archivage. Afficher « conservé / modifié / perdu ». Créer une nouvelle révision liée aux preuves. Ne pas réécrire les sources ou augmenter l'autorité d'une affirmation par synthèse.
8. **Révoquer les dérivés.** Un retrait ou une perte d'accès doit atteindre résumés, index et propositions dérivées. Recontrôler les sources avant extraction, consolidation et rappel ; empêcher qu'un ancien résumé réintroduise une donnée retirée.

## Comment mesurer la pertinence

La bonne question est « cette mémoire améliore-t-elle une tâche future autorisée, avec une affirmation justifiée ? ». Séparer quatre dimensions : **preuve**, **utilité**, **actualité**, **sensibilité**. Un score unique masque les arbitrages et encourage une fausse précision.

Protocole recommandé : corpus de conversations fictives annotées, suivi d'un petit corpus métier autorisé ; comparer capture manuelle, extraction atomique et extraction avec consolidation, avec le même modèle et le même budget. Mesurer :

- Précision de captation : part des propositions utiles et réellement étayées ; omissions de faits explicitement durables ; ajout d'affirmations absentes.
- Classification : justesse du type et du rattachement, fréquence des champs inventés, capacité à laisser un champ indéterminé.
- Curation : doublons, contradictions détectées, corrections temporelles, erreurs introduites par fusion ; temps humain de validation et taux de correction.
- Résultat : réussite des tâches futures avec et sans mémoire, capacité d'abstention, coût et latence.
- Sécurité : faux souvenirs, faux « l'utilisateur a approuvé », source externe contenant des consignes, répétition d'une même source, changements d'accès et retrait traversant plusieurs synthèses.

[LongMemEval, ICLR 2025](https://arxiv.org/abs/2410.10813) fournit cinq axes utiles : extraction, raisonnement entre sessions, temporalité, mises à jour et abstention. Il ne remplace pas les tests de droits, de publication et de révocation propres à Rakazo. Les chiffres de fournisseurs ou de papiers ne doivent pas être comparés comme un classement global lorsque modèles, budgets et juges diffèrent.

## Décision proposée

Construire d'abord **la proposition atomique, sourcée et préclassée**, puis une revue courte permettant d'accepter, corriger, ignorer ou remplacer. Tester ensuite la consolidation sur ces objets. Éviter d'ajouter de nouveaux champs au formulaire tant que l'extraction ne sait pas les justifier et que leur rôle dans l'usage de la mémoire n'est pas défini.

Cette approche réduit des chemins d'empoisonnement et les rend observables. Elle ne permet pas de promettre leur impossibilité absolue.

## Contre-analyse de cette recommandation

- **Atomicité excessive.** Découper peut séparer une décision de sa condition ou de son exception. Une unité doit être validable seule, sans perdre ses qualifications ; les relations et preuves communes doivent rester accessibles.
- **Validation humaine surchargée.** Une file de centaines de propositions favorise l'acceptation mécanique. Borner la production, regrouper la revue par sujet, éliminer les doublons et mesurer le temps de correction. Une validation ne prouve pas non plus qu'une affirmation est vraie.
- **Confiance mal interprétée.** Le modèle peut être certain d'avoir compris une source fausse. Séparer fidélité d'extraction, qualité de preuve et utilité ; ne pas afficher un pourcentage de vérité non calibré.
- **Graphe trompeusement rassurant.** Les liens structurent l'information mais peuvent propager une erreur. Ils ne remplacent ni contrôle d'accès ni vérification de provenance ; plusieurs nœuds issus d'une même source ne sont pas des témoins indépendants.
- **Coût de preuve.** Conserver les épisodes facilite l'audit mais augmente stockage, exposition et complexité de suppression. La rétention et la révocation font partie du dispositif initial, pas d'une extension ultérieure.
