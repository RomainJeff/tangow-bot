# Mémoire — bilan du premier incrément

Complément : la [recette exploratoire dans le navigateur](2026-09-24-memory-functional-edge-cases.md) a ensuite reproduit des défauts d'import, de traçabilité et d'interface. Les vérifications passantes ci-dessous ne signifient pas une absence de défaut fonctionnel.

24 septembre 2026. Référence : [plan d'implémentation](../plans/2026-09-24-memory-capture-implementation.md). Découpage initial par trois agents Sol 6 low, réalisation par agents Luna 6 high, intégration par l'agent principal. Une revue Sol indépendante a complété les vérifications.

## Résultat livré

- Suppression de la saisie OKR et du regroupement par objectifs, sans perte des anciennes valeurs. Type de document OKF/Tolaria, nature et rattachements sont distincts et facultatifs.
- Preuves structurées : source/version, extrait exact, auteur utilisateur ou assistant, visibilité contrôlée par le serveur. Une citation vérifiée ne prouve pas la vérité du contenu.
- Compaction et demande d'extraction enregistrées dans la même transaction ; candidats individuels, reprise bornée, idempotence et vérifications de révocation entre candidats.
- Classement local à partir de voisins autorisés, sans activation automatique. Adaptateur Jev optionnel testé hors ligne.
- Import/export OKF : Markdown conservé, import en proposition, métadonnées inconnues inertes et références importées non résolues sans décision explicite.
- Consolidation de 2 à 8 mémoires d'une même collection : rédaction Markdown, revue des sources, acceptation explicite avec conservation ou remplacement. Les dépendances de synthèses sont revérifiées récursivement pour le rappel et l'acceptation.
- Écrans web/Electron et mobile, entrée personnelle contextualisée, variante [M02–M09](memory-okf-prototype.html).

## Vérifications exécutées

| Vérification | Résultat | Portée |
| --- | --- | --- |
| Types contracts, memory, adapters, API, testkit | Passants | Contrats partagés et serveur |
| Types web et mobile | Passants | Pas de recette visuelle native |
| Tests unitaires ciblés, 12 suites | 144 cas passants après correction des doubles de test | Rappel, classement, OKF/Jev, compaction, reprise, révocation et outils mémoire |
| PostgreSQL : bibliothèque | 7 cas passants | Import inerte, classement, consolidation, sources obsolètes, droits, édition et dépendances imbriquées |
| PostgreSQL : capture | 4 cas passants | Rollback curseur/outbox, panne et retry, refus inchangé, source ou appartenance modifiée |
| PostgreSQL : écritures concurrentes | 5 cas passants | Contrat canonique et isolation |
| PostgreSQL : migration | 1 cas passant | Conservation de l'héritage |
| Navigateur Chromium | 6 parcours passants | Capture, Markdown, partage/retrait, conflit d'édition, héritage, classement, import/consolidation |
| Catalogues web | Extraction et compilation réussies | Traductions manquantes utilisent encore la langue source |
| Image Docker | Construction réussie | API, worker et web de la même image |
| Migration Docker locale | Réussie après sauvegarde | 73 documents et 76 révisions conservés |
| Instance locale | API et web répondent ; services démarrés | Bibliothèque partagée et menu des nouvelles actions vérifiés dans le navigateur connecté |

Les 12 suites unitaires ont d'abord trouvé six doubles de test incomplets ; après correction, l'exécution finale des 12 suites passe avec 144 cas. La recette web a d'abord trouvé un sélecteur de menu limité à son parent alors que le menu est rendu dans un portail ; les cinq autres parcours passent et le sixième a été rejoué avec succès après correction. Ce bilan distingue ces exécutions ciblées d'une exécution de toute la CI.

Captures locales produites dans `apps/web/test-results/` : M01 capture, M03 bibliothèque, M04 lecture, M05 édition, M06 aperçu, M07 revue de classement, M08 sources et M09 synthèse. Ce répertoire est généré et peut être remplacé au prochain test ; aucune URL de capture CI n'est revendiquée. Les captures M08/M09 ont été inspectées visuellement après le dernier parcours.

## Restant du plan

1. Déclenchement d'acquisition à la clôture des tâches courtes, avec budget et éligibilité ; actuellement l'automatisme dépend de la compaction.
2. Comparaison calibrée de Jev avec un modèle structuré ; la connexion dans les réglages est livrée dans l'incrément ci-dessous. Aucun appel Jev avec une vraie clé n'a été effectué.
3. Cache, budget par espace, traitement différé et embeddings facultatifs ; la base actuelle est lexicale et bornée, sans clusterisation sémantique automatique.
4. Génération automatique des synthèses et détection sémantique des contradictions ; l'utilisateur rédige actuellement la synthèse et décide du remplacement.
5. Évaluation générative contre les attaques de contexte, corpus calibration/test séparés, mesure de pertinence et de coût réel.
6. Recette native (clavier, retour système, accessibilité), captures CI et traduction des nouveaux libellés.

Les garde-fous contrôlent les droits, le statut, les versions, les extraits et les dépendances. Ils n'offrent pas de garantie absolue contre un modèle qui suivrait une instruction malveillante présente dans une donnée autorisée. Aucun commit, aucune PR ni déploiement distant ne sont inclus dans ce bilan.

## Incrément : connexion du classificateur Jev

Les réglages Memory affichent une connexion de classement distincte du stockage : fournisseur,
modèle, clé masquée et « Test and connect ». La connexion est partagée dans l'espace nommé,
modifiable par ses propriétaires et stockée avec un secret chiffré. Un échec de vérification
conserve la connexion précédente. La déconnexion revient au classement lexical local.
Le même contrat est exposé dans un écran natif mobile ; l'exécution native n'a pas été testée manuellement.

Le classement explicite utilise maintenant cette connexion et demande un consentement propre
au classement, par utilisateur/espace/modèle. Le test de connexion utilise un texte fictif.
Les propositions ne sont jamais acceptées automatiquement. La revue affiche le modèle utilisé
et distingue une indisponibilité d'une absence de suggestion.

Validation : 24 tests ciblés passent (connexion, propriétaire révoqué pendant le test, chiffrement,
remplacement de clé, suppression ciblée, résolution et consentement, adaptateur Jev). Trois
parcours Chromium passent en environnement isolé : formulaire/erreur/connexion/réouverture/
déconnexion, navigation des réglages, et classement local avec revue. Les réponses Jev sont
simulées dans ces tests ; aucune efficacité sémantique n'en est déduite. Le premier essai sur
l'instance Docker a été bloqué par l'onboarding des nouveaux comptes, qui exige un modèle ;
les parcours ont ensuite été exécutés dans le harnais de test prévu par le projet.

Les vérifications de types API, web et mobile passent. La migration additive de configuration
est appliquée à l'instance locale après sauvegarde. Le formulaire a été vérifié dans le navigateur
connecté. Les captures `memory-classifier-connection.png` et `memory-classifier-connected.png`
sont produites par le nouveau parcours E2E ; aucune capture CI n'est revendiquée.
