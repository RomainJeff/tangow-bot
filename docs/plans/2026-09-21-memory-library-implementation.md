# Mémoire des agents — plan d’implémentation

> Mise à jour du 24 septembre : les choix OKR, le classement manuel par défaut et les évolutions de classification ci-dessous sont remplacés par le [cadrage correctif](2026-09-24-memory-framing.md) et le [nouveau plan](2026-09-24-memory-capture-implementation.md). Les maquettes d'objectifs restent historiques. Les exigences de droits, de versionnement et de Markdown sont conservées.

Date : 21 septembre 2026. Statut : implémentation locale en cours de recette, fondée sur l’audit du code actuel. Ce document ne signifie pas que la fonctionnalité est déployée.

### État de réalisation

La bibliothèque canonique, les commandes versionnées, le partage indépendant, le rappel local gouverné et les parcours Markdown web / Electron / mobile sont implémentés. Les [scénarios CI](../../apps/web/e2e/memory-library.spec.ts) reprennent V01 à V09 ci-dessous ; ils ne remplacent pas une recette visuelle effectivement exécutée. La [documentation d’utilisation et de bascule](../memory.md) précise le comportement livré dans le code.

Le rappel des fournisseurs Serenity / Supermemory reste suspendu, avec repli local explicite : aucun adaptateur existant n’assure ici la résolution de résultats vers une révision canonique. L’indexation distante et son outbox ne sont donc pas activés. Les connexions sont conservées sans réinjection directe des anciens faits fournisseur.

Le déploiement progressif utilise `Space.memoryRecallEnabled`, contrôlé côté serveur, sans nouvel écran permanent. La migration transforme les documents hérités en propositions ; les nouveaux espaces et agents commencent avec des collections vides. Le déploiement, les captures CI, la recette native et l’évaluation générative de pertinence restent des validations distinctes de la suite déterministe locale.

Validation locale de l’implémentation : contrôles de types des 23 packages réussis ; 5 055 tests réussis, 170 ignorés ; suite d’intégration PostgreSQL complète réussie, incluant migration, droits, publication, concurrence et parcours Pi hors ligne. Le contrôle de style du code produit passe avec sept avertissements préexistants. Le contrôle global du dépôt signale encore les anciennes maquettes HTML archivées. Les tests de compaction vérifient les requêtes réellement envoyées au modèle et l’absence de proposition lorsqu’une dépendance est retirée pendant l’extraction. Les scénarios visuels V01–V09 sont écrits mais n’ont pas été exécutés localement ; aucune capture ni recette native n’est déclarée validée.

## 1. Résultat attendu

Permettre de **retenir une information, la retrouver, la corriger et la partager**, avec une interface courte et une mémoire réellement contrôlée par Rakazo.

La référence est la [dernière maquette Markdown](../research/memory-markdown-prototype.html). Les maquettes précédentes, plus chargées, ne constituent pas le périmètre à implémenter. Les recherches sur [les espaces et la pertinence](../research/2026-09-21-memory-spaces-and-relevance.md), [la compaction](../research/2026-09-21-agentic-compaction-relevance.md) et [le context poisoning](../research/2026-09-21-memory-poisoning-defenses.md) éclairent les choix ; leurs propositions ne sont pas des capacités déjà disponibles.

Le contenu reste en Markdown. Son propriétaire, son audience, sa qualification, sa provenance et son état sont des données structurées, indépendantes du texte. L’interface expose ces détails à la demande.

### Visuels de référence

**Ouvrir la [maquette interactive de référence — mémoire et Markdown](../research/memory-markdown-prototype.html).** Les repères V01 à V09 ci-dessous désignent ses écrans et états, et sont repris dans les lots d’implémentation. Les liens ouvrent la maquette ; les chemins de clic permettent d’atteindre le bon état. Le prototype ne possède pas de liens directs par écran. Fermer d’abord la fiche avec × si elle est ouverte ; la maquette peut conserver l’état de la consultation précédente.

| Repère | Visuel et accès dans la maquette | Éléments à reprendre | Lots |
| --- | --- | --- | --- |
| **V01** | [Conversation / capture](../research/memory-markdown-prototype.html) → **Atlas** → **Retenir pour Atlas** → **Voir** | Action contextualisée, retour Retenu, accès à la fiche et annulation | 2, 5 |
| **V02** | [Bibliothèque partagée](../research/memory-markdown-prototype.html) → **Mémoire** → **Équipe Produit** | Recherche, Ajouter, lignes courtes et groupes d’objectifs ; aucun détail développé par défaut | 1, 2, 5 |
| **V03** | [Mémoire de l’agent / personnelle](../research/memory-markdown-prototype.html) → **Atlas** → bouton **Mémoire** ; ou sélecteur **Atlas · privé** / **Moi** | Une bibliothèque commune, filtrée selon le point d’entrée ; périmètre visible | 1, 2, 5 |
| **V04** | [Lecture Markdown](../research/memory-markdown-prototype.html) → **Mémoire** → **Équipe Produit** → **Tester les invitations** | Fiche « Souvenir », titre, liste de tâches, emphase ; contenu avant Détails | 4, 5 |
| **V05** | [Édition Markdown](../research/memory-markdown-prototype.html) → V04 → **Modifier** → **Écrire** ; nouvelle mémoire via **Ajouter** | Zone de saisie, barre de formatage, Annuler / Enregistrer ; même éditeur en création et modification | 2, 4, 5 |
| **V06** | [Aperçu du brouillon](../research/memory-markdown-prototype.html) → V05 → **Aperçu** → **Écrire** | Rendu du contenu en cours sans sauvegarde ni transformation de la source | 4, 5 |
| **V07** | [Publication d’un extrait](../research/memory-markdown-prototype.html) → **Mémoire** → **Atlas · privé** → **Limiter les entretiens à la recherche de documents.** → **Partager** | Destination « Avec », texte publié éditable, Écrire / Aperçu ; **Source → Joindre cet extrait** facultatif ; original privé | 1, 2, 4, 5 |
| **V08** | [Qualification et impact](../research/memory-markdown-prototype.html) → V04 → **Détails**, ou V05 → **Classement** | Source, type, objectif et impact révélés à la demande ; label ambre contextualisé | 1, 2, 5 |
| **V09** | [Historique et retrait](../research/memory-markdown-prototype.html) → modifier une fiche puis **Enregistrer** → **Détails → Historique · 1** ; **Détails → Retirer** | Ancienne version consultable ; action de retrait et retour Annuler | 2, 3, 5, 6 |

Les exemples Atlas, Équipe Produit et Projet Orion sont fictifs. Le visuel définit la hiérarchie et les interactions ; les règles de droits, de révision et de cycle de vie de ce plan définissent le comportement réel. En particulier :

- Le bouton de capture visible sous le message dans V01 sera intégré au menu d’actions du message existant, pour éviter une barre permanente.
- « Projet Orion » illustre un périmètre : il ne justifie pas de créer un accès projet sans modèle de droits. Seules les destinations autorisées seront proposées.
- V07 affiche un extrait de source prérempli, avec une case pour le joindre ; l’implémentation doit permettre de vérifier exactement le texte et les métadonnées partagés. La filiation privée n’est jamais rendue publique par le visuel.
- Les types et contraintes de classement de la démo sont exploratoires. La qualification facultative et les valeurs du modèle décrit plus bas font référence ; ne pas rendre l’objectif obligatoire pour toute mémoire.
- Le scénario **Équipe Produit → Durée des invitations → À vérifier** montre un arbitrage entre deux faits. Il ne représente pas le conflit technique de deux sauvegardes simultanées et n’introduit pas la détection sémantique automatique dans la V1.

### Visuels antérieurs et statut

| Maquette | Utilité conservée | Statut pour l’implémentation |
| --- | --- | --- |
| [Mémoire simplifiée](../research/memory-simple-prototype.html) | Densité réduite et parcours retenir → retrouver → partager | Précurseur ; la version Markdown ci-dessus la remplace comme référence principale |
| [Parcours mémoire complet](../research/memory-journey-prototype.html) | Exploration des points d’entrée et transitions | Archive d’exploration ; ne pas reprendre tous ses écrans |
| [Mémoire structurée par objectifs](../research/memory-structure-prototype.html) | Organisation par objectifs et essais de labels d’impact | Archive ; ne pas réintroduire sa densité ni son tableau de bord |
| [Espaces de mémoire](../research/memory-spaces-concept.html) | Distinction agent / collectif et contexte de tâche | Référence conceptuelle ; les permissions effectives restent celles du présent plan |

### États visuels à compléter pendant l’implémentation

La maquette montre le parcours principal, pas encore tous les états nécessaires. Prévoir dans le lot 5, avant la recette UI : acceptation d’une proposition automatique, conflit de révision avec brouillon conservé, erreur de sauvegarde et fermeture avec modifications, validité temporelle, consultation / restauration des mémoires retirées et sélection de leurs publications à retirer. Le bilan de migration appartient au lot 6. Réutiliser la fiche et les composants existants pour ces états, sans ajouter une navigation principale pour chacun.

Les pages et sheets **natives mobiles** restent à décliner : la version HTML responsive n’est pas une maquette native. Le manifeste de contexte est un livrable de données du lot 3 ; aucun nouvel écran d’observabilité n’est requis pour la V1.

### Parcours à livrer

| Point d’entrée | Action | Résultat | Visuel |
| --- | --- | --- | --- |
| Navigation → Mémoire | Choisir un périmètre, rechercher | Une bibliothèque de lignes courtes | V02 |
| Agent → Mémoire | Ouvrir | La même bibliothèque, filtrée sur cet agent | V03 |
| Menu d’un message → Retenir | Confirmer le contenu retenu si une sélection est nécessaire | Une mémoire dans le périmètre de l’agent, avec accès à Voir / Annuler | V01 |
| Bibliothèque → Ajouter | Écrire puis enregistrer | Une mémoire dans le périmètre sélectionné | V05 |
| Ligne de mémoire | Ouvrir | Le contenu rendu ; les détails restent repliés | V04, V08 |
| Fiche → Modifier | Écrire / Aperçu → Enregistrer | Une nouvelle révision, sans perte du Markdown | V05, V06 |
| Fiche → Partager | Choisir la destination, relire le contenu exact → Partager | Une publication distincte ; l’original reste privé | V07 |
| Fiche → Détails | Retirer | L’information cesse d’être proposée aux prochaines exécutions | V09 |

« Retenir » est une action explicite de l’utilisateur. Une extraction automatique produit une proposition, accessible dans la bibliothèque lorsqu’il y en a, jamais une mémoire active par défaut.

### Périmètre de la première version

- Bibliothèque, recherche locale, lecture, création, édition Markdown, partage, retrait et historique.
- Mémoires personnelles, propres à un agent et partagées dans un espace existant.
- Qualification facultative : nature, sujet, objectif / résultat clé, impact et période de validité.
- Validation des propositions d’agents depuis la même bibliothèque, sans tableau de bord supplémentaire.
- Web et Electron sur la même UI ; parcours équivalents sur mobile avec navigation native.
- Fonctionnement complet sans fournisseur de mémoire externe.

Le regroupement automatique, les consolidations générées, la détection sémantique des contradictions et un véritable gestionnaire d’OKR viennent ensuite. La première version conserve leurs prérequis de provenance et de version, sans ajouter leurs écrans.

## 2. Écart avec l’existant

| Aujourd’hui, dans le code | Conséquence pour l’implémentation |
| --- | --- |
| `MemoryDocument` et `MemoryRevision` stockent des documents `bot` / `user`, avec historique transactionnel. | Étendre cette base, ne pas créer un second stockage de vérité. |
| La liste et les modifications sont filtrées par `spaceId` **et** `userId`. | Le document appelé « partagé » dans les réglages n’est pas une mémoire d’équipe accessible à plusieurs membres. |
| `remember` écrit localement ; `save_memory` écrit chez le fournisseur. | Unifier les écritures avant de promettre correction et retrait depuis l’interface. |
| La compaction extrait des faits puis les ajoute directement au `MEMORY.md` actif. | Transformer ces extractions en propositions. |
| Le rappel local injecte du texte non échappé dans les instructions système. | Déplacer ce texte vers un contexte de données et appliquer les contrôles de sélection. |
| Les fournisseurs utilisent `isolated` / `shared` ; le mode partagé duplique des écritures. | Ne pas assimiler ces namespaces aux droits de partage du produit. |
| L’édition actuelle est un textarea ; `ChatMarkdown` existe sur web et mobile. | Réutiliser le rendu et ajouter une petite barre d’édition. |
| `Space` et `SpaceMember` existent ; aucun modèle `Team` ou `Project` canonique n’a été trouvé. | Appuyer les droits sur `Space`, sans inventer une frontière d’accès à partir d’un label. |

Points de code : [schéma DB](../../packages/db/prisma/schema.prisma), [stockage mémoire](../../packages/memory/src/index.ts), [contrats RPC](../../packages/contracts/src/rpc.ts), [API](../../apps/api/src/router.ts), [exécuteur](../../packages/adapters/src/executor.ts), [compaction](../../packages/adapters/src/history-compaction.ts), [contexte mémoire](../../packages/adapters/src/memory-context.ts), [UI actuelle](../../apps/web/src/pages/KnowledgeSection.tsx), [réglages](../../apps/web/src/pages/MemorySettingsOverlay.tsx).

## 3. Décisions de conception

### Propriété et partage

Introduire une collection mémoire comme frontière explicite, en réutilisant les identités existantes.

| Collection | Propriété et accès humain | Consultation par un agent |
| --- | --- | --- |
| Personnelle | Un utilisateur dans un `Space` ; privée | Ses agents autorisés, dans une conversation dont l’audience est compatible |
| Agent | Un bot et son propriétaire dans un `Space` ; privée par défaut | Ce bot, sous les mêmes contraintes d’audience |
| Partagée | Le `Space` ; lecture par ses membres | Agents autorisés dans cet espace, pour une audience compatible |

Politique proposée pour la V1 : tout membre peut publier explicitement une mémoire dans son espace ; l’auteur humain de la publication et le propriétaire de l’espace peuvent la modifier ou la retirer. Les autres membres peuvent la lire. Ces capacités sont calculées côté serveur et retournées à l’interface. L’administrateur d’un espace n’acquiert pas, par cette fonction, l’accès aux mémoires personnelles de ses membres.

Une publication sélectionne le contenu **et** les métadonnées visibles : titre, classement et éventuel extrait de source. La conversation d’origine, ses participants, son titre et ses liens privés ne sont jamais hérités automatiquement. La filiation privée reste interne au serveur. Toute mise à jour d’une publication exige une nouvelle action explicite.

La publication possède son propre contenu et son historique. Elle survit à la suppression du bot ou du document privé source : la filiation ne doit pas propager leur suppression en cascade. Conserver seulement une référence interne non destructive ou une trace minimale de provenance lorsque la source disparaît, sans créer de nouvel accès à cette source.

En V1, le partage reste dans l’espace courant. Un projet représenté par un `Space` bénéficie de cette frontière existante. Sinon, « projet » ou « objectif » est un classement, sans effet sur les permissions. Ne pas afficher quatre périmètres fictifs si les droits correspondants n’existent pas.

### Objet mémoire et révisions

Faire évoluer `MemoryDocument` et `MemoryRevision`, avec :

| Élément | Données nécessaires |
| --- | --- |
| Identité | Identifiant stable, collection, titre court, contenu Markdown, numéro de révision |
| Attribution | Auteur humain ou agent, validateur humain, dates ; valeurs établies côté serveur |
| Cycle de vie | `proposed`, `active`, `withdrawn`, `superseded` ; état distinct de la fiabilité |
| Qualification facultative | Nature `fact`, `decision`, `preference`, `procedure` ; sujets ; impact `normal` ou `important` |
| Contexte facultatif | Objet structuré `objective` / `keyResult` avec libellés ; un résultat clé exige un objectif |
| Temporalité | Début / fin de validité facultatifs, indépendants de la date de modification |
| Sources | Références vérifiées vers message, document, thread ou run ; provenance « héritée » si inconnue |
| Filiation | Révision source d’une publication et lien explicite de remplacement ; accès contrôlé séparément |

Les libellés objectif / résultat clé permettent de classer et filtrer sans introduire un système d’OKR complet. Ils ne sont ni des droits ni des identifiants de projet. Leur rattachement futur à un référentiel d’objectifs sera une évolution distincte.

Une révision comprend le contenu et les métadonnées publiées ensemble. Les événements d’activation, retrait et remplacement sont attribués et historisés. Chaque mutation reçoit `expectedRevision` ; un conflit renvoie un état exploitable par l’UI sans écraser le brouillon. Les captures, publications et reprises d’exécution utilisent une clé d’idempotence.

Le titre initial est dérivé localement de la première ligne utile et reste modifiable. Ni titre obligatoire supplémentaire ni génération LLM nécessaire pour créer une mémoire.

### Écriture et activation

- La création humaine explicitement retenue crée une version active dans une collection où la personne a ce droit.
- Une modification conserve l’état courant : corriger une proposition ne l’accepte pas ; modifier une mémoire retirée ne la réactive pas. Accepter ou restaurer est une commande explicite, avec droit dédié et révision attendue. Une mémoire active corrigée reste active.
- `remember`, `save_memory` et l’extraction après compaction créent des propositions via le même service. Un paramètre déclaré par le modèle ne peut pas faire passer une proposition pour une validation humaine.
- Accepter une proposition active exactement la révision examinée. Une modification concurrente impose une nouvelle lecture.
- La compaction reste une opération de continuité de conversation. Son résumé ne devient pas automatiquement une connaissance durable ou partagée.
- Corriger produit une révision ; remplacer désigne explicitement la mémoire remplacée. Une consolidation ultérieure sera une proposition avec ses sources, pas une fusion destructive.

### Sélection pour une tâche

L’ordre des contrôles est déterminant :

1. Déterminer l’identité demandeuse, l’espace, le bot et l’audience effective de la réponse. Pour une audience externe ou incertaine, exclure les mémoires privées incompatibles.
2. Filtrer les collections autorisées, l’état et la période de validité. Aucun score ne contourne ce filtre.
3. Rechercher localement par contenu / titre, puis enrichir éventuellement avec un fournisseur compatible.
4. Classer selon la tâche, les correspondances de contexte et la diversité ; ne pas assimiler récence ou importance à vérité. Éviter doublons et copies d’une même source.
5. Charger les révisions canoniques, revérifier les droits et appliquer un budget de contexte explicite. Pour un résultat externe non résoluble vers une révision autorisée, s’abstenir.
6. Transmettre les extraits comme données, avec leurs références et limites de validité ; permettre une recherche complémentaire soumise aux mêmes règles.

Le fonctionnement initial utilise une recherche lexicale côté base, des règles déterministes et un budget borné. Le choix d’une pondération sémantique plus sophistiquée attend les évaluations. Le badge « Important » n’épingle pas automatiquement un document dans tous les prompts.

Une question historique peut consulter des versions remplacées encore autorisées, dans un mode explicitement historique. Un retrait de sécurité reste exclu de tous les rappels. L’historique de l’interface est un accès distinct, soumis aux droits actuels.

Pour chaque appel au modèle, conserver un manifeste des identifiants, révisions et extraits transmis, avec la raison de sélection. Ce journal ne prouve pas une influence causale. Son accès respecte les mêmes restrictions que les données qu’il contient ; aucune duplication de texte privé dans la télémétrie générale.

## 4. Lots d’implémentation

### Lot 1 — Modèle, droits et migration préparatoire

**Visuels reliés : V02, V03, V07 et V08** dans la [maquette de référence](../research/memory-markdown-prototype.html) — périmètres, publication et qualification. Ces écrans expriment les besoins auxquels répond le modèle ; la démo ne prouve pas les contrôles d’accès.

**Travail**

- Étendre le schéma avec collections, qualification, provenance, états et révisions complètes.
- Définir les contrats dans `packages/contracts` ; distinguer le périmètre produit des scopes techniques des fournisseurs.
- Centraliser la politique d’accès et les transitions dans `packages/memory`. Réutiliser les transactions et retries existants ; maintenir les routes API fines.
- Définir des clés uniques adaptées aux collections. Auditer les doublons avant migration : l’ancienne clé contient un `botId` nullable et ne suffit pas pour le nouveau modèle.
- Préparer un backfill idempotent, sans supprimer les anciennes colonnes dans ce lot. Mettre à jour la création des espaces et des bots pour éviter de recréer des documents hors du modèle canonique.
- Adapter les règles de suppression : une mémoire privée peut suivre le cycle de vie de son bot, mais une publication dans l’espace et ses révisions restent autonomes. Tester la suppression des sources aussi bien que leur retrait.

**Migration des données existantes**

- Conserver intégralement identifiants, texte et historique ; aucune découpe, réécriture ou classification automatique par LLM.
- Mapper `user` vers la collection personnelle du propriétaire, `bot` vers sa collection agent. Ne jamais élargir les droits au motif que l’ancienne UI disait « Shared ».
- Marquer la provenance inconnue comme héritée. Les documents sans preuve d’activation humaine sont présentés comme propositions au passage au nouveau rappel ; ils restent consultables et peuvent être acceptés après lecture. Ne pas annoncer leur disparition ni leur validation implicite.
- Produire un bilan : documents et révisions transférés, anomalies, documents à relire. Vérifier par empreintes que le contenu a été préservé.

**Validation du lot** : deux utilisateurs du même espace restent isolés dans leurs collections privées ; aucun accès inter-espace ; les droits partagés sont testés ; le backfill rejoué ne duplique rien et préserve chaque révision.

### Lot 2 — Service mémoire et API de parcours

**Visuels reliés : V01 à V03, V05, V07 à V09** dans la [maquette de référence](../research/memory-markdown-prototype.html) — chaque action visible doit correspondre à une commande autorisée et versionnée côté serveur.

**Travail**

- Ajouter les opérations de bibliothèque : liste paginée de résumés, lecture d’une fiche, recherche, création / capture, mise à jour, acceptation d’une proposition, publication, retrait, historique et export Markdown.
- Ne pas télécharger tous les contenus pour afficher la liste. Calculer compteurs, résultats et facettes dans le périmètre autorisé.
- Vérifier côté serveur les sources fournies lors de « Retenir » ; distinguer texte du message et extrait édité par l’utilisateur. Ne pas accepter un auteur ou une permission déclarés par le client.
- Traiter la publication comme une opération atomique : destination autorisée, révision source attendue, contenu exact, métadonnées sélectionnées, attribution et filiation privée.
- Fournir `canEdit`, `canPublish`, `canWithdraw` et les sources effectivement visibles. Ne pas envoyer une source privée à un client qui doit seulement la masquer.
- Appliquer `expectedRevision` aux changements de contenu, de classement et d’état. L’annulation de « Retenir » ne retire que la version créée par cette action si elle n’a pas changé entre-temps.
- Adapter l’export existant et l’export des bots aux nouveaux droits ; le Markdown exporté ne contient pas de provenance privée inaccessible.

**Validation du lot** : créer → corriger → publier un extrait → lire avec un autre membre fonctionne sur API ; double clic / retry ne crée qu’une publication ; une modification concurrente renvoie un conflit ; aucun titre, compteur, export ou historique ne révèle une source privée.

### Lot 3 — Runtime, compaction et fournisseurs

**Visuel relié : V09, retrait**, dans la [maquette de référence](../research/memory-markdown-prototype.html). Le retour « Retiré des prochains contextes » exprime la promesse à vérifier dans le runtime ; une notification simulée ne la démontre pas. Les contrôles de ce lot ne nécessitent pas de nouvel écran permanent.

**Travail**

- Raccorder tous les chemins d’écriture au service canonique : outils, runtime Pi et autres runtimes concernés, commits de fin d’exécution, import et extraction après compaction. Rechercher les appels directs restants avant bascule.
- Remplacer les écritures automatiques actives par des propositions. Aucun mode fournisseur ne masque ou contourne le chemin canonique.
- Sortir le corps des mémoires de `buildSystemInstructions`. Fournir un bloc de données de moindre priorité adapté à chaque runtime, avec échappement, taille bornée et références. L’échappement seul ne constitue pas une défense suffisante.
- Implémenter la sélection décrite plus haut, y compris l’audience des canaux externes. Les permissions d’outils et d’actions restent indépendantes de tout texte mémorisé.
- Ajouter le manifeste du contexte transmis. Réexaminer les caches, préfixes de prompts et reprises pour qu’une révision retirée ne réapparaisse pas.
- Propager les dépendances de révision aux réponses produites, aux résumés de compaction et aux propositions dérivées. Le champ actuel `Thread.historyCompactionSummary`, qui ne contient que du texte, doit recevoir une provenance exploitable : filtrer le prochain rappel ne suffit pas si un résumé conserve le même fait.
- Lors d’un retrait ou d’une révocation, invalider les résumés, caches et copies d’historique fournisseur dépendants avant reprise. Reconstruire le contexte à partir de sources encore admissibles ; si les dépendances d’un ancien résumé ou d’une réponse sont inconnues, écarter cet artefact entier du contexte automatique. Ne pas demander à un modèle de certifier qu’il a supprimé toutes les paraphrases du contenu interdit.
- Faire évoluer le contrat de fournisseur vers une indexation de révisions canoniques : ID / révision résolubles et capacités déclarées. Créer une intention d’indexation dans la transaction DB, puis un traitement idempotent avec retry ; ne pas réutiliser une file métier incompatible.
- Revalider chaque résultat externe contre le canonique. Une panne, une indexation en retard ou une suppression distante non disponible ne bloque pas les fonctions locales et ne réactive pas une mémoire retirée.

**Compatibilité fournisseur**

Serenity expose actuellement des IDs et un retrait unitaire ; Supermemory ne renvoie pas d’ID dans l’adaptateur actuel et ne propose pas de retrait unitaire dans ce contrat. Aucun des deux n’offre ici de contrat d’export exhaustif. Vérifier les capacités réelles au moment de l’implémentation, puis adapter. Si la correspondance fiable n’est pas réalisable, utiliser la recherche locale pour le rappel gouverné. Ne pas déduire l’identité d’une mémoire de sa similarité textuelle.

Les faits existant seulement chez un fournisseur ne sont pas annoncés comme tous migrés. Prévoir un import explicite en propositions lorsque les données sont récupérables et un bilan des données non couvertes. Désactiver leur injection directe après bascule.

**Retrait et révocation**

Le retrait canonique bloque immédiatement les prochains rappels, même avant purge de l’index. Une publication est indépendante : retirer l’original privé ne retire pas silencieusement la version explicitement publiée ; son menu permet de retirer également les publications connues que l’utilisateur peut gérer. Une révocation d’accès invalide les consultations et contextes futurs concernés. Avant le prochain appel au modèle, interrompre ou reconstruire une exécution utilisant un contexte désormais interdit ; conserver les contrôles d’autorisation avant chaque action. Le texte déjà transmis à un modèle ne peut pas être « désappris » rétroactivement.

Les messages passés ne sont pas réécrits pour donner l’illusion d’un effacement. Leur consultation respecte les droits actuels ; leur réutilisation automatique dans une reprise suit les dépendances ci-dessus. Le retrait d’une mémoire, le retrait de ses publications connues et l’effacement de données sont des opérations différentes : la V1 décrit précisément le retrait qu’elle réalise.

Cette garantie porte sur la réinjection par les mécanismes gouvernés de mémoire et leurs dérivés connus. Une information présente indépendamment dans un message d’origine encore autorisé ne disparaît pas de la conversation du seul fait du retrait d’une mémoire ; sa suppression exige une action distincte sur cette source.

**Validation du lot** : une compaction empoisonnée ne s’active pas seule ; le fournisseur ne peut ni forger un ID autorisé ni ressusciter une révision ; les traces montrent l’absence des contenus retirés aux appels suivants ; le produit fonctionne avec fournisseur absent ou indisponible.

### Lot 4 — Lecture et édition Markdown partagées

Ce lot peut avancer en parallèle des lots 1 à 3.

**Visuels de réalisation : V04, V05, V06 et V07** dans la [maquette de référence](../research/memory-markdown-prototype.html) — lecture, saisie, aperçu et réemploi du même éditeur lors du partage.

**Travail**

- Réutiliser `@rakazo/chat-ui/web` et `@rakazo/chat-ui/native` pour la lecture et l’aperçu, avec `allowImages={false}`. Aucun chargement automatique de ressource distante ni HTML exécutable.
- Ajouter les transformations pures du texte et de la sélection dans `packages/core`, puis une petite primitive d’édition dans `packages/ui-web` et son adaptation native. Garder le rendu Markdown dans `chat-ui` et composer la fiche sans introduire de cycle de dépendances.
- Proposer Écrire / Aperçu, titre, gras, italique, listes, cases, lien et code. Les tableaux sont lisibles et éditables en Markdown sans éditeur de tableaux supplémentaire.
- Garder la chaîne Markdown comme source unique : pas de conversion HTML → Markdown, pas de normalisation silencieuse à la sauvegarde.
- Gérer sélection, raccourcis, IME, accents, historique d’annulation, blocs contenant des backticks et insertion multiligne. Une bascule Aperçu ne change pas le brouillon.
- Fixer une limite de document partagée dans les contrats. Rendre lisibles les anciens documents plus longs ; aucune troncature ne peut devenir le contenu sauvegardé. La limite du budget de rappel reste distincte de celle du document.
- Préserver le brouillon sur erreur réseau et conflit. En V1, le brouillon reste en mémoire du client ; avertir à la sortie uniquement si des changements seraient perdus. Pas de stockage persistant de contenu privé dans un cache générique.

Les bibliothèques embarquées dans la maquette autonome ne sont pas copiées en production. Réutiliser les dépendances déjà présentes et la politique commune de liens sûrs ; ne pas exécuter de schéma d’URL interne depuis une mémoire.

**Validation du lot** : source identique après Écrire → Aperçu → Écrire ; caractères et sélection préservés ; aucun HTML exécuté ou appel d’image externe ; clavier, lecteur d’écran et rendu des cas Markdown retenus vérifiés sur web et natif.

### Lot 5 — Bibliothèque et parcours complets sur les trois surfaces

**Visuels de réalisation : V01 à V09** dans la [maquette de référence](../research/memory-markdown-prototype.html), avec les chemins de clic de l’index en section 1. Les variantes natives et états manquants listés dans cette section font partie de ce lot ; les anciennes maquettes ne s’y ajoutent pas comme écrans obligatoires.

**Web / Electron**

- Ajouter la destination Mémoire dans la navigation et une route explicite, sans collision avec `/app/:botId` ni redirection automatique vers le premier chat.
- Implémenter la bibliothèque, la fiche, l’édition et le partage avec les tokens et primitives de `@rakazo/ui-web`.
- Conserver scope, recherche et sélection dans un état navigable. Le retour navigateur rétablit la liste ; une réponse tardive après changement d’espace ne peut pas afficher les anciennes données.
- Ajouter le raccourci agent et l’action Retenir au menu du message. Réutiliser la même fiche depuis toutes les entrées.
- Remplacer l’ancienne liste éditable de `KnowledgeSection` par un accès à la bibliothèque. Garder la configuration du fournisseur dans les réglages avancés.
- Dans la fiche : contenu d’abord, Modifier / Partager, puis Détails replié pour source, classement, validité et historique. Afficher les propositions uniquement lorsqu’elles existent ; validation sur le contenu visible.

**Mobile**

- Ajouter des routes mémoire, détail et édition via Expo Router ; entrée dans la navigation existante et depuis les réglages agent.
- Ajouter Retenir au menu de pression longue du message.
- Utiliser des pages plein écran pour lecture / édition, des menus et sheets natifs pour périmètre / partage ; préserver le brouillon face au clavier et au retour système.
- Réutiliser les contrats, mutations et règles partagés. Lecture, ajout, édition, validation, partage, retrait et historique ne restent pas réservés au web.

**Sobriété de l’interface**

La liste montre le titre et, si utile, une information secondaire. Les champs de qualification sont facultatifs et repliés. Pas de score de pertinence permanent, carte de graphe ou tableau de bord OKR. Les labels de périmètre restent neutres ; « Important » utilise le token warning lorsqu’il est affiché, un conflit avéré le token destructive, toujours avec un libellé accessible. Aucun badge vert ne prétend certifier une vérité.

**Validation du lot** : un utilisateur effectue retenir → retrouver → modifier / aperçu → partager → retirer sans passer par les réglages du fournisseur. Captures CI de la bibliothèque, lecture, édition, partage et états utiles ; recette native distincte pour clavier et navigation. Electron réutilise le web sans nouveau pont natif.

### Lot 6 — Bascule et évaluation de bout en bout

**Visuels de recette : V01 à V09** dans la [maquette de référence](../research/memory-markdown-prototype.html), à reproduire sur les données migrées. Le bilan de migration reste un état à concevoir, affiché seulement lorsqu’une action est nécessaire.

**Travail**

- Activer le nouveau parcours par espace, via un mécanisme de déploiement temporaire côté serveur ; ne pas exposer deux systèmes concurrents de mémoire dans l’UI.
- À la bascule, suspendre les anciennes écritures de mémoire, drainer ou reprendre les traitements en cours, appliquer le delta du backfill, puis redémarrer uniquement avec le service canonique. Vérifier qu’aucun ancien worker n’écrit encore.
- Montrer le bilan de migration lorsqu’une action est requise : documents hérités à relire ou données fournisseur non récupérées. Ne pas remplir l’interface quotidienne de messages techniques.
- Reconstituer les index à partir du canonique ; contrôler les comptes, empreintes, droits et reprises. Ne supprimer les colonnes de compatibilité qu’après validation de la bascule.
- Prévoir un arrêt du nouveau rappel et un retour temporaire à l’usage sans mémoire si nécessaire. Ne jamais revenir à l’injection système ou réactiver les écritures fournisseur contournant le canonique. Les données et révisions sont conservées.
- Mesurer utilité, omissions, latence et coût sur des fixtures versionnées avant d’ajuster le classement. Journaliser des IDs et métriques, pas les contenus privés dans les logs généraux.

**Validation du lot** : la recette ci-dessous passe avec recherche locale et fournisseurs simulés ; la migration et la reprise après interruption sont reproductibles ; aucun fournisseur hébergé n’est requis pour les fonctions annoncées.

## 5. Tests et conditions de livraison

Les captures CI du parcours portent les mêmes repères **V01 à V09** pour permettre de comparer la réalisation à la maquette. Ajouter les captures des états manquants au moment de leur réalisation ; les images web ne remplacent pas la recette native. Les références et chemins ci-dessus ont été vérifiés dans les fichiers des prototypes ; cette mise à jour documentaire ne constitue pas une nouvelle validation de leur rendu visuel.

### Parcours bloquants

| Cas | Résultat attendu |
| --- | --- |
| Retenir un message, fermer la fiche, le retrouver | Contenu et source corrects, une seule mémoire |
| Modifier pendant qu’un autre client sauvegarde | Conflit explicite, brouillon intact, aucun écrasement |
| Corriger une proposition ou une mémoire retirée | État inchangé ; acceptation ou restauration reste explicite |
| Publier un extrait privé puis ouvrir avec un autre membre | Seul l’extrait et les métadonnées approuvées sont visibles |
| Publier puis supprimer le bot source | Publication et historique partagé conservés, aucun accès à la source privée |
| Chercher depuis un autre utilisateur / espace | Aucun résultat, titre, compteur ou extrait interdit |
| Agent répondant dans un canal plus large que la source | La mémoire privée incompatible n’entre pas dans son contexte |
| Retirer une mémoire encore présente dans l’index ou un cache | Absence aux prochains rappels et appels concernés |
| Rappel → réponse → compaction → retrait / révocation → nouvel appel | Contexte reconstruit sans les artefacts dépendants ; absence de nouvelle proposition dérivée de cette copie |
| Révoquer les droits pendant l’indexation / une exécution | Aucun nouvel accès ou appel avec le contexte révoqué |
| Source contenant « ignore les instructions », faux rôle ou faux validateur | Proposition non activée ; aucune promotion d’autorité ni de permission |
| Retry d’outil, compaction ou publication | Pas de doublon ni d’activation supplémentaire |
| Fournisseur absent, en panne, résultat périmé ou ID forgé | Fonctions locales opérationnelles, résultats invalides exclus |
| Markdown avec HTML, URL piégée, image ou fences imbriquées | Pas d’exécution ni de chargement implicite ; texte conservé |
| Navigation clavier, lecteur d’écran, mobile, changement d’espace | Actions accessibles, focus et état cohérents, aucune fuite par réponse tardive |

### Suites à étendre

- `packages/memory/src/index.test.ts` et `commit.postgres.test.ts` : transitions, droits, concurrence réelle, publication et migration.
- `packages/adapters/src/memory-context.test.ts`, `executor-recall.test.ts`, `history-compaction.test.ts`, `executor-effect-idempotency.test.ts` : branchements réels, propositions, budget, révocations et retries.
- Tests des adaptateurs Serenity / Supermemory et de la factory : capacités, résolution canonique, suppression, fallback, fonctionnement hors réseau.
- Tests des fonctions d’édition dans `packages/core` et du rendu dans `packages/chat-ui` ; tests UI des brouillons et erreurs.
- `apps/web/e2e/knowledge-panel.spec.ts`, `settings-shell.spec.ts`, `message-hover-actions.spec.ts` : remplacer les attentes de l’ancienne UI et couvrir le parcours complet avec deux identités fictives.
- Harness Pi hors réseau et scénarios d’évaluation : couvrir les canaux de sortie et le passage compaction → proposition → activation → rappel.
- Smoke tests et captures natives selon l’infrastructure mobile existante, avec recette clavier / sélection. Les captures web ne valident pas le rendu natif.

Exécuter les tests ciblés puis les vérifications de types et de lint des packages touchés. Les tests transactionnels utilisent PostgreSQL ; les doubles en mémoire ne prouvent pas l’isolation concurrente. Les tests Electron ouvrant de vraies fenêtres restent en CI, pas sur la machine du mainteneur.

### Évaluation de la pertinence et du poisoning

Comparer, sur les mêmes tâches et jeux de données figés : absence de mémoire, comportement actuel utilisé uniquement comme référence de test, nouveau rappel local, puis rappel enrichi. Séparer chronologiquement les données mémorisées et les questions de test.

Mesurer couverture des faits nécessaires, omissions critiques, exactitude de réponse, abstention, contradictions, contexte superflu, tokens et latence. Inclure un fait ancien mais valide, une correction récente, une exception, une question historique, des copies répétées d’une même source et une réponse dont la bonne mémoire est absente.

Les fuites, promotions non autorisées et résurrections de contenu retiré ont une tolérance nulle dans la suite déterministe de livraison. Les attaques génératives mesurent aussi le comportement final du modèle : isoler correctement une mémoire ne garantit pas qu’il ignore toute instruction malveillante. Une batterie réussie réduit le risque ; elle ne démontre pas l’absence absolue de context poisoning. Conserver également des cas utiles pour éviter une défense qui désactive de fait toute mémoire.

## 6. Ordre et découpage de livraison

| Lot | Dépendances | Peut avancer en parallèle avec |
| --- | --- | --- |
| 1. Modèle et droits | Aucune | 4 |
| 2. Service et API | 1 | 4, préparation de 3 |
| 3. Runtime et fournisseurs | 1–2 | 4, UI sur contrats stabilisés |
| 4. Markdown | Contrat de contenu / limite commun | 1–3 |
| 5. Parcours web, Electron et mobile | 2 + 4 ; 3 avant activation du rappel | Fin de 3 |
| 6. Bascule et évaluation | 1–5 | — |

Chaque lot doit rester découpable en PRs revues séparément : schéma et politique ; commandes ; runtime ; fournisseurs ; éditeur ; parcours web ; parcours natifs ; bascule. Les changements préparatoires restent inactifs jusqu’à la disponibilité des dépendances. La bibliothèque seule ne permet pas de déclarer le retrait ou le partage sûrs si l’ancien runtime fonctionne encore.

Premier résultat visible recommandé : lecture et édition Markdown sur les documents existants, avec précondition de révision côté API. Cette amélioration peut être livrée avant la nouvelle bibliothèque ; elle ne change pas encore les scopes ni les règles de mémorisation.

La fonction complète est prête lorsque les trois surfaces couvrent le parcours, que les anciens chemins d’écriture sont fermés, que les données héritées sont conservées et identifiées, et que les tests d’isolation / révocation / compaction passent. Mettre à jour `CHANGELOG.md` pour chaque résultat effectivement livré ; ne pas créer d’entrée pour ce plan. Les PRs UI documentent les nouveaux libellés nécessaires et pointent vers leurs captures CI.

## 7. Évolutions après cette base

1. **Regroupement suggéré** : proposer sujets / objectifs à partir de mémoires déjà accessibles ; corriger les rattachements sans déplacer ni copier les contenus.
2. **Consolidation** : prévisualiser une nouvelle mémoire avec les révisions sources, exceptions et périodes ; accepter explicitement avant activation ; conserver la possibilité de revenir aux sources.
3. **Contradictions** : rapprocher uniquement des informations comparables par périmètre et période ; faire choisir la correction ou le remplacement, sans arbitrage silencieux.
4. **Objectifs reliés à un référentiel réel** : remplacer les simples libellés par des références autorisées lorsque Rakazo dispose d’un modèle objectif / résultat clé ou d’une intégration adaptée.
5. **Sélection adaptative** : mesurer la contribution des mémoires sur des replays et améliorer le rappel ; ne pas convertir fréquence de rappel ou citation en score public de vérité.

Ces évolutions réutilisent le canonique, les sources et les transitions. Aucune ne peut élargir l’audience, transformer une proposition en instruction ou contourner une révocation.
