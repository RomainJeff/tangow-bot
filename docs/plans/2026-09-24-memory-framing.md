# Mémoire Rakazo — cadrage correctif et fonctionnel

Date : 24 septembre 2026. Statut : proposition de référence pour la prochaine implémentation ; aucune nouvelle capacité livrée par ce document.

Ce cadrage et son [plan d'implémentation](2026-09-24-memory-capture-implementation.md) remplacent les choix OKR, le classement manuel par défaut et les évolutions de classification du [plan du 21 septembre](2026-09-21-memory-library-implementation.md). Ils conservent ses exigences de droits, de révisions, de publication indépendante et d'édition Markdown. Les références visuelles sont précisées dans le plan : les maquettes existantes ne sont pas entièrement conformes au nouveau cadrage.

## 1. Problème et résultat attendu

La bibliothèque permet de lire, modifier et partager des mémoires, mais l'acquisition reste insuffisamment structurée. Le formulaire demande à la personne de classer une information sans expliquer sa provenance ni proposer des rattachements fiables. L'amalgame OKF/OKR a introduit des champs et des groupes d'objectifs qui ne répondent pas à la demande.

Résultat attendu : depuis une conversation, un agent ou un espace, retrouver une information utile, comprendre d'où elle vient, corriger une proposition et maîtriser qui pourra l'utiliser. Le système prépare le classement ; la personne arbitre surtout les ambiguïtés et les changements de sens.

## 2. État constaté et corrections

| Constat | Décision de cadrage | Priorité |
| --- | --- | --- |
| Objective / Key result et regroupement par objectifs proviennent de l'amalgame OKF/OKR | Retirer ces champs du parcours courant ; préserver les données héritées sans conversion sémantique automatique | P0 |
| Classification manuelle longue, champs techniques ou avancés permanents | Contenu d'abord ; rattachements suggérés ; détails à la demande | P0 |
| Entrée globale Memory contestée | Privilégier les entrées agent, espace et menu utilisateur ; conserver les URL et l'accès transversal par recherche/menu, sans entrée permanente dédiée dans la barre latérale | P0, proposition UX à vérifier en recette |
| remember ne fournit pas de classification structurée | Ajouter une étape serveur de préparation de propositions sourcées | P1 |
| La compaction peut regrouper jusqu'à dix éléments dans une proposition | Séparer les unités validables sans perdre conditions, exceptions ou contexte nécessaire | P1 |
| Pas de rapprochement sémantique structuré | Détecter les voisins puis proposer doublon, complément, contradiction ou remplacement possible | P1 |
| Du texte historique « à valider » peut contredire le statut actif | Transmettre un statut canonique séparé du contenu ; ne pas réécrire silencieusement le Markdown | P0 |
| Les données de démonstration vérifient surtout l'interface | Ajouter corpus annoté, scénarios adversariaux et mesure d'utilité | P1 |

Ces constats sont documentés dans l'[audit de classification](../research/2026-09-24-memory-classification-audit.md). Ils ne signifient pas que les protections d'accès existantes sont absentes.

## 3. Modèle fonctionnel

**OKF est un format de représentation et d'échange**, pas un algorithme de classement. Le profil Tolaria consulté s'appuie sur OKF v0.1 et distingue Daily, Memory, Note, Meeting, Document, Person, Project, Responsibility et Topic. La spécification publique consultée est v0.2 ; aucune migration implicite de version ne fait partie de cette correction.

| Notion | Sens et règle |
| --- | --- |
| Source | Message ou document identifié et versionné, avec auteur observé et droits ; son contenu ne peut pas déclarer lui-même son autorité |
| Proposition | Information candidate avec preuves et classement proposé ; exclue du rappel durable actif avant acceptation |
| Mémoire | Contenu Markdown versionné, état et audience contrôlés par le serveur |
| Type de document | Objet du profil OKF/Tolaria ; distinct de la nature de l'énoncé |
| Nature | Décision, préférence, observation, procédure ou hypothèse ; classement facultatif, jamais certificat de vérité |
| Rattachement | Lien à une entité identifiée : projet, responsabilité, sujet ou personne ; pas un simple libellé faisant office de droit |
| Groupe thématique | Vue dérivée de rapprochements, réversible et reconstruisible ; n'implique ni fusion ni partage |
| Consolidation | Proposition d'une nouvelle version ou synthèse fondée sur des sources précises, avec différences consultables |

Un souvenir « le lancement est reporté à octobre » peut être de type Memory, de nature décision et lié à un Project. Une réunion est une source possible ; elle n'est pas la nature de cette décision. Les journaux Daily et les documents Meeting ne nécessitent pas neuf nouveaux écrans de création : le profil décrit les objets, pas un formulaire universel.

Les métadonnées produites par un modèle sont des suggestions. Les identifiants de provenance, les audiences et les validations viennent du système. Conserver la version du schéma, de l'extracteur et du classifieur afin d'expliquer et refaire le traitement.

## 4. Espaces et parcours

- **Personnelle** : informations utilisables dans le contexte personnel autorisé. Point d'entrée : menu utilisateur et recherche.
- **Agent** : mémoires du bot dans son contexte autorisé ; point d'entrée depuis l'agent. Le mot agent ne signifie pas automatiquement privé : les règles du bot et de son espace restent explicites.
- **Équipe** : bibliothèque de l'espace partagé, accessible à ses membres autorisés. Point d'entrée depuis l'espace.

Un changement de filtre ne déplace pas une mémoire. Partager crée une publication explicite et indépendante avec aperçu de ce qui sera visible ; il n'ouvre pas la source privée. La suppression d'une source privée et le retrait d'une publication sont deux opérations distinctes : la publication autorisée ne disparaît pas automatiquement avec son bot source ; en revanche une révocation pour contamination doit permettre d'identifier les publications dépendantes à examiner.

Parcours prioritaires :

1. **Retenir** depuis un message : capture explicite autorisée, source attachée, retour bref et accès à la fiche. L'enrichissement peut arriver ensuite sans bloquer la capture ni changer ses droits.
2. **Examiner une suggestion** : contenu, rattachement et source à la demande ; Garder, Modifier, Ignorer. Un refus empêche de reproposer le même candidat inchangé.
3. **Retrouver** depuis l'agent ou l'espace : recherche et liste courte ; regroupement par sujets lorsqu'il apporte une aide, retour possible à une liste simple.
4. **Corriger** : même éditeur Markdown, modes Écrire/Aperçu ; les corrections humaines priment sur les nouvelles suggestions du classifieur.
5. **Résoudre un conflit** : comparer les affirmations et dates ; conserver les deux, remplacer explicitement ou ignorer la proposition. Une nouvelle date ne prouve pas que la nouvelle affirmation est correcte.
6. **Consolider** : revoir le résultat proposé, ce qui change et ses sources ; aucune fusion silencieuse.
7. **Partager / retirer** : destination et contenu explicites, historique conservé selon rétention, retrait propagé aux dérivés techniques concernés.

## 5. Acquisition et classement

Déclencheurs : demande de retenir, proposition d'agent, clôture d'un échange ou d'une tâche utile. La compaction demeure un mécanisme de continuité technique ; elle n'est pas l'unique déclencheur de mémoire durable.

Chaîne cible : source autorisée → unités candidates avec preuves → élimination des répétitions exactes → recherche de voisins autorisés → classification et relations proposées → revue → activation → rappel contextualisé.

Commencer par des rattachements et voisins, sans imposer un moteur global de clustering. Un élément peut rester isolé ou appartenir à plusieurs groupes. La proximité sémantique n'établit ni l'identité de deux faits, ni leur vérité, ni la transitivité d'une fusion.

Jev est un adaptateur optionnel à évaluer pour les décisions bornées. Il ne remplace pas l'extracteur génératif ni les règles serveur. Un petit modèle à sortie structurée constitue un comparateur ; sans fournisseur configuré, capture manuelle, lecture, édition et recherche locale restent utilisables. Les cas sans classification restent non classés.

## 6. Sécurité et maîtrise du coût

Contraintes bloquantes : aucun élargissement d'audience par classement ; aucune instruction issue d'une source externe promue en autorité ; contrôle des droits avant traitement externe et rappel ; statut canonique indépendant de la prose ; révocation des index, caches et synthèses techniques dépendants ; aucune corroboration artificielle par répétition d'une source.

Une validation humaine ou une confiance élevée n'est pas une preuve de vérité. Les attaques par fausse affirmation doivent être testées autant que les instructions manifestement malveillantes. Il n'est pas possible de garantir l'absence absolue de poisoning par un classifieur.

Coût : extraction différée bornée, embeddings par version, voisins en nombre limité, cache versionné et escalade des ambiguïtés seulement. Aucun appel Jev réel ni envoi de données privées n'est requis pour développer les contrats ou la suite hors ligne. L'évaluation connectée utilise un corpus synthétique ou explicitement autorisé.

## 7. UX et limites de périmètre

Conserver le rendu et l'éditeur Markdown existants. Éviter scores publics, graphe permanent et badges de vérité. Les statuts utiles emploient les tokens sémantiques avec libellé accessible ; la couleur seule ne code jamais une information. Respecter le système monochrome, l'identité des bots et les états warning/destructive sans palette par catégorie.

Inclus : correction du parcours, profil typé et liens, captation sourcée, classification suggérée, regroupements réversibles, conflits et consolidation proposés, portabilité OKF explicite, évaluation et migration.

Exclus : automatisation d'une gouvernance d'objectifs, gestion de projet complète, partage inféré, fusion autonome des mémoires actives, restauration non contrôlée des anciens fournisseurs distants, graphe de connaissances généraliste, garantie absolue anti-poisoning.

## 8. Critères de succès et contre-analyse

La personne retrouve et corrige une mémoire sans saisir une taxonomie ; comprend l'audience avant publication ; voit la preuve d'une suggestion ; peut refuser une consolidation. Les trois surfaces couvrent les actions applicables, avec interactions natives sur mobile.

Mesurer précision des propositions et rattachements, omissions, fausses fusions, abstention, temps de correction, coût par mémoire acceptée, puis réussite de tâches futures avec/sans mémoire. Séparer jeu de calibration et test ; les seuils de production sont fixés avant le test final, pas ajustés sur ses résultats.

Risques à surveiller : trop fragmenter perd les exceptions ; trop proposer surcharge la revue ; trop consolider dégrade les sources ; un graphe peut multiplier les liens faux ; conserver les preuves augmente le besoin de rétention et de suppression. Réponse : unités autonomes mais contextualisées, file bornée, originaux traçables, regroupements réversibles et budget explicite.

Sources : [captation et curation](../research/2026-09-24-memory-capture-literature.md), [OKF et Jev](../research/2026-09-24-memory-jev-classification.md). Les mécanismes recommandés sont des choix produit, pas des résultats déjà mesurés dans Rakazo.
