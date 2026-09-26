# Mémoire Rakazo — plan correctif et acquisition structurée

Date : 24 septembre 2026. Statut : premier incrément implémenté, testé et déployé localement ; le plan complet reste partiellement réalisé. Voir le [bilan de validation](../research/2026-09-24-memory-implementation-validation.md). Référence produit : [cadrage](2026-09-24-memory-framing.md). Ce plan remplace les dispositions OKR et les évolutions de classification du [plan initial](2026-09-21-memory-library-implementation.md), sans annuler ses protections déjà construites.

### Découpage d'exécution

Trois audits Sol 6 (raisonnement faible) ont identifié les frontières de fichiers avant exécution par Luna 6 (raisonnement élevé). Les changements préexistants restent conservés.

| Segment | Propriétaire de réalisation | Périmètre exclusif initial | État |
| --- | --- | --- | --- |
| UI | Luna UI puis Luna workflow UI | Variante de maquette corrigée, pages mémoire web/mobile, navigation, tests UI | Intégré ; 6 parcours web passants ; recette native restante |
| Canonique | Luna core puis Luna workflows | Contrats RPC/domaine, service mémoire, schéma/preuves, capture API, tests associés | Intégré ; tests de droits et dérivés passants |
| Runtime | Luna capture puis Luna capture hardening | Compaction, rappel, contrats adapter-kit nécessaires, tests runtime | Intégré ; tests ciblés et PostgreSQL passants |
| Enrichissement | Luna enrichment puis Luna workflows/UI | Classification, portabilité, consolidation et interfaces de revue | Base locale intégrée ; Jev testé hors ligne uniquement |
| Intégration | Agent principal | Documentation, traductions générées, vérifications croisées et recette | Vérifications ciblées et déploiement Docker local réalisés |

Les preuves et les limites sont détaillées dans le bilan de validation. Les tests ne valent pas validation de l'ensemble des lots ni garantie absolue contre l'injection de contexte.

### Limites du premier incrément

Le déclencheur automatique livré reste la compaction, complété par les actions explicites Retenir et remember. La captation à la clôture d'une tâche courte reste à construire avec une politique d'éligibilité et de budget ; ce n'est pas un appel de modèle ajouté à chaque tour.

Le classement par défaut utilise une recherche lexicale bornée. La connexion optionnelle Jev est désormais sélectionnable dans les réglages mémoire de l'espace et utilisée pour la revue de classement après autorisation de partage des données. Son contrat est testé hors ligne ; aucun appel avec une vraie clé n'est revendiqué. Cache de classement, budget par espace, embeddings, traitement différé et calibration comparative restent à livrer. Le seuil lexical ne représente ni une probabilité calibrée ni une vérification factuelle.

La consolidation proposée est écrite et revue par l'utilisateur dans l'éditeur Markdown. Cet incrément ne génère pas automatiquement une synthèse, ne détecte pas sémantiquement toutes les contradictions et ne fabrique pas des groupes transversaux par similarité.

Les tests déterministes vérifient accès, transitions, citations et reprise. Ils ne remplacent pas l'évaluation générative anti-injection, la recette native ni les captures CI. La nouvelle instance Docker locale a été reconstruite et vérifiée avec conservation des données existantes.

## 1. Références visuelles et écarts explicites

Les fichiers ci-dessous sont des prototypes existants, pas des captures de l'application ni des maquettes déjà corrigées. Ils peuvent conserver le dernier état consulté : fermer la fiche avant de suivre les chemins. Le lot 0 doit produire leurs variantes corrigées avant réalisation des nouveaux écrans.

La [variante OKF corrigée](../research/memory-okf-prototype.html) présente désormais M02–M05 et M07–M09, avec liens entre les étapes. Elle remplace les exemples d'objectifs pour la nouvelle réalisation ; elle ne prouve pas que les mécanismes de classification ou consolidation sont déjà intégrés.

| Repère | Visuel existant et chemin | À conserver | À corriger ou concevoir | Lots |
| --- | --- | --- | --- | --- |
| M01 | [Markdown](../research/memory-markdown-prototype.html) → Atlas → Retenir pour Atlas | Capture contextualisée, accès à la fiche | Action dans le menu du message ; source et statut réels | 0, 1, 3 |
| M02 | [Espaces](../research/memory-spaces-concept.html), vues agent et collectif ; [Markdown](../research/memory-markdown-prototype.html) → Mémoire → sélecteur de périmètre | Distinction personnel / agent / équipe | Entrées contextuelles, retrait du lien latéral permanent, recherche transversale autorisée | 0, 1 |
| M03 | [Markdown](../research/memory-markdown-prototype.html) → Mémoire → Équipe Produit | Recherche, liste courte | Remplacer les groupes d'objectifs par liste/rattachements ; états vide et non classé | 0, 1, 4 |
| M04 | Même prototype → ouvrir une fiche → Modifier → Écrire / Aperçu | Markdown, brouillon, annulation | Retirer Objective / Key result ; rattachements suggérés à modifier à la demande | 0, 1, 2 |
| M05 | Même prototype → fiche → Détails | Source, historique, divulgation progressive | Séparer type/nature/liens ; héritage consultable ; statut canonique | 0, 1, 2 |
| M06 | Même prototype → Atlas · privé → fiche → Partager | Aperçu éditable de la publication | Vérifier audience et métadonnées, accès membre distinct | 1, 6 |
| M07 | [Parcours](../research/memory-journey-prototype.html), exploration des suggestions | Principe de revue contextuelle uniquement | Nouvelle variante requise : candidat, preuve, rattachement, Garder/Modifier/Ignorer, erreur et attente | 0, 3, 4 |
| M08 | Prototype Markdown → Équipe Produit → Durée des invitations → À vérifier | Comparaison de deux informations | Nouvelle variante : périodes, preuves, choix conserver/remplacer ; distinguer conflit d'édition | 0, 5 |
| M09 | Aucun visuel conforme existant | — | Nouvelle variante : groupe thématique → proposition de synthèse → changements et sources → acceptation | 0, 5 |

La [maquette par objectifs](../research/memory-structure-prototype.html) est archivée et non normative. Ne reprendre ni ses OKR, ni sa palette de catégories. Sur mobile : pages natives pour contenu/édition, menus et sheets pour choix ; captures web insuffisantes pour valider clavier et retour système.

## 2. Lots et critères de sortie

### Lot 0 — Verrouiller le parcours corrigé et le corpus de recette

Livrables : variantes visuelles M02–M05 et M07–M09 ; parcours cliquable court ; fixtures fictives avec décisions, exceptions, doublons, corrections datées, refus et changements de droits. Réutiliser les primitives Quiet, pas le style brut des prototypes.

Critères : atteindre les mémoires depuis agent/espace/menu utilisateur ; conserver navigation directe et retour ; retenir puis revoir une suggestion en quelques actions ; aucun objectif obligatoire ; aucun score ou vocabulaire technique permanent. Revue des variantes avant d'étendre le formulaire produit. Cette revue valide un résultat concret, pas une nouvelle demande de cadrage.

### Lot 1 — Corriger l'interface actuelle sans migration destructive

Fichiers : `apps/web/src/pages/MemoryLibraryPage.tsx`, `pages/shell/sidebar.tsx`, `KnowledgeSection.tsx`, `MemorySettingsOverlay.tsx`, `App.tsx` ; `apps/mobile/app/memory*.tsx` et entrées natives ; locales concernées. Vérifier aussi `packages/adapters/src/memory-context.ts`.

Travail : enlever la saisie OKR et le regroupement implicite par objectifs ; afficher une liste simple en attendant les liens ; relocaliser l'entrée mémoire selon M02 ; préserver recherche, URL, collection, sélection et brouillon. Garder les valeurs héritées dans les révisions et une section de détails consultable. Ne convertir aucun objectif libre en Project ou Topic automatiquement. Ne pas faire dépendre Important d'un objectif.

Le rappel expose séparément état, provenance et rôle informatif du contenu ; le serveur continue de filtrer l'éligibilité. Une ancienne phrase « à valider » n'est pas supprimée automatiquement.

Sortie : M01–M06 utilisables web/Electron/mobile ; tests de navigation directe, brouillon, affichage hérité et statut ; captures CI des écrans corrigés. Aucun changement d'audience ni perte de données.

### Lot 2 — Ajouter le profil de connaissance et la provenance structurée

Fichiers : `packages/contracts/src/domain.ts`, `rpc.ts`, `packages/db/prisma/schema.prisma`, migration additive, dépôts DB, `packages/memory/src/library.ts`, `index.ts`, `apps/api/src/router.ts`.

Modèle cible à traduire dans les primitives existantes :

- Profil et version explicites ; type de document, nature facultative, références d'entités et relations typées. Réutiliser l'identité canonique des documents pour les concepts quand elle suffit ; ne pas créer un second moteur de documents.
- Preuves par candidat : source et version, passage/range vérifiable, auteur fourni par le serveur, dépendances ; source absente ou supprimée distinguée de source vérifiée.
- Métadonnées de proposition : origine manuelle/extracteur, décision de classification, modèle et schéma utilisés ; correction humaine verrouillée contre les reclassements automatiques.
- Liens de remplacement et périodes séparés des modifications éditoriales ; changements sous précondition de révision.
- Relations visibles uniquement lorsque leurs deux extrémités sont accessibles ; aucun titre ou compteur interdit dans les réponses.

Sortie : migration et relecture aller-retour sans perte ; types inconnus tolérés pour l'import futur ; droits et révisions contrôlés par le service partagé, pas le frontend. Aucun modèle ne fournit une audience ou une validation faisant autorité.

### Lot 3 — Captation atomique, prouvable et reprise fiable

Fichiers : `packages/adapters/src/builtin-tools.ts`, `history-compaction.ts`, `executor.ts`, contrats de l'adapter-kit, service mémoire et route capture. Utiliser le mécanisme de tâches persistantes existant après inventaire ; ajouter une file/outbox minimale seulement si aucun mécanisme ne couvre les reprises.

Travail : unifier Retenir, remember et extraction différée vers le canonique tout en conservant leur différence d'intention. Retenir humain peut activer le contenu explicitement sélectionné ; une extraction d'agent produit des propositions. Un remember non étayé peut rester une proposition attribuée à l'agent, jamais une affirmation humaine présumée.

Extraire un candidat par unité validable avec ses conditions et citations. Valider mécaniquement les références et extraits ; une vérification sémantique est un signal supplémentaire. Déclencher à la clôture utile et sur demande ; borner le volume, ne pas lancer à chaque token/tour. La compaction utilise ce même chemin, sans gros document de dix faits par défaut.

Clé de reprise : source/version, déclencheur, version d'extracteur et candidat stable. Déduplication exacte distincte du rapprochement sémantique. Revalider droits et versions avant publication des résultats ; ignorer un résultat devenu obsolète. Conserver un refus par candidat/version afin de ne pas le reproposer indéfiniment. Aucun refus n'interdit de soumettre une preuve réellement nouvelle.

Sortie : M07 fonctionnel, garde/modification/refus indépendants ; crash/retry sans doublon ; retrait pendant extraction sans réintroduction ; source exacte consultable selon droits. Continuité du chat si extraction indisponible.

### Lot 4 — Classement peu coûteux et groupes réversibles

Contrat partagé dans le domaine mémoire ; adaptateurs dans `packages/adapters` et configuration dans les connexions partagées. Ne pas ajouter de variable d'environnement spécifique Jev si la connexion générique suffit. Recherche locale comme base ; embeddings optionnels selon capacités configurées.

Pipeline : filtre d'accès → déduplication exacte → recherche de quelques voisins → jugements bornés → suggestions de type/nature/rattachement/relations. Prévoir indéterminé et aucun. Les groupes sont des vues dérivées dans un périmètre autorisé ; pas de fusion par transitivité de similarité.

Comparer adaptateur de modèle structuré et Jev derrière le même contrat. Cache sur entrée, versions de source, schéma, modèle et périmètre ; invalidation à la révocation. Stocker usage, latence et erreurs sans texte privé dans les logs généraux. Traitement asynchrone et budget par espace ; arrêter proprement à épuisement.

Choisir les seuils sur calibration annotée, puis figer pour le test. Une confiance de classement n'active pas la mémoire. La correction humaine prime ; les ambiguïtés restent visibles uniquement quand utiles.

Sortie : M03/M04/M07 préclassés, fonctionnement sans réseau via adaptateurs simulés, aucun fournisseur hébergé obligatoire ; rapport comparant précision, abstention, coût et fausses associations. Activation Jev seulement après résultat acceptable sur le corpus, accès disponible et configuration explicite.

### Lot 5 — Contradictions et consolidation avec revue

Fichiers : services mémoire, contrats/API et composants de revue partagés par les surfaces. Réutiliser éditeur, diff et historique existants plutôt que construire un second outil d'édition.

Comparer sens, sujet, dates, conditions et sources. Ne pas assimiler toute différence à un conflit ni toute information récente à un remplacement. Proposer une synthèse avec sources/révisions et changements ; accepter sous préconditions des révisions sources. Si une source change ou devient inaccessible, invalider la proposition avant acceptation.

Conserver les originaux selon rétention ; historique du remplacement et possibilité de revenir à une version toujours autorisée. Une synthèse n'est pas sa propre preuve. Lancer la consolidation sur demande, puis envisager des suggestions différées bornées après mesure ; aucune fusion active automatique dans ce périmètre.

Sortie : M08/M09 ; décisions conservées/remplacées explicitement ; exception non perdue ; preuve révoquée non réintroduite ; répétition d'une source non comptée comme corroboration indépendante.

### Lot 6 — Portabilité, évaluation et déploiement

Ajouter export/import OKF avec profil/version documentés, Markdown intact et métadonnées inconnues conservées dans une zone non autoritative. Importer comme propositions : un fichier ne peut pas s'attribuer les droits, la vérification ou l'auteur de confiance du serveur. Les références hors du lot importé restent non résolues. Exporter uniquement les sources et relations autorisées, sans fuite de filiation privée.

Préserver les valeurs OKR héritées dans l'export de compatibilité ; ne supprimer les champs de stockage qu'après politique de migration explicite et vérification de conservation. L'application peut cesser de les saisir avant cela.

Déployer progressivement : corrections UI → schéma compatible → captation en mode observation → revue → classement → consolidation. Le mode observation évalue sans activer de contenu. Les flags serveur peuvent arrêter séparément extraction, enrichissement, consolidation et rappel ; ne pas restaurer un ancien chemin fournisseur non gouverné.

Sortie : tests et rapport d'évaluation, migration/reprise testées, recette Docker locale avec données fictives, parcours à deux identités, captures CI web, recette native, documentation `docs/memory.md`. Vérifier l'export/import, la rétention, les droits et le retrait avant activation globale.

## 3. Dépendances et découpage

| Lot | Dépendance | Résultat livrable |
| --- | --- | --- |
| 0 | Cadrage | Variantes et corpus de recette |
| 1 | 0 pour navigation/classement | Correction UX et suppression de l'amalgame visible |
| 2 | Cadrage | Contrats et stockage compatibles, sans activation automatique |
| 3 | 2, variantes M07 | Suggestions prouvables et revue |
| 4 | 2–3 | Classement et regroupements suggérés |
| 5 | 3–4, variantes M08–M09 | Consolidation révisable |
| 6 | Chaque lot avant sa bascule ; 2 pour échange OKF | Livraison contrôlée et bilan |

Les lots 1 et 2 peuvent avancer indépendamment après accord des contrats ; fixtures et évaluation commencent au lot 0. Faire des PRs distinctes : correction UX, schéma/migration, acquisition, classement/adaptateurs, consolidation, portabilité et bascule. Ne pas attendre le dernier lot pour vérifier les droits.

## 4. Matrice de validation

| Risque / comportement | Preuve attendue |
| --- | --- |
| Perte des anciens objectifs | Migration puis export conservent valeurs et révisions ; pas de conversion inventée |
| Mauvaise atomicité | Négation, exception et période restent attachées à la proposition |
| Mauvaise attribution | Message cité comme document externe ne devient pas déclaration utilisateur |
| Injection / fausse approbation | Aucun changement de droits, validation ou outil autorisé par le texte ; tests de comportement du modèle séparés |
| Doublon ou refus répété | Retry idempotent ; candidat inchangé refusé non reproposé |
| Mauvaise fusion | Faits proches mais distincts et contradictions restent séparés sans validation |
| Fuite par cluster | Aucun contenu, libellé, titre ni compteur issu d'un élément interdit |
| Révocation tardive | Résultats asynchrones, résumés et caches réexaminés avant usage |
| Publication indépendante | Un membre voit uniquement le contenu publié ; suppression du bot privé ne divulgue ni ne supprime arbitrairement la publication |
| Panne fournisseur | Chat et bibliothèque utilisables ; enrichissement repris ou abandonné sans doublon |
| Import malveillant | Métadonnées d'autorité ignorées ; import en proposition ; Markdown sûr |
| Parcours multi-surface | M01–M09 applicables accessibles ; brouillons et navigation préservés |

Étendre les suites existantes : `packages/memory/src/*test.ts`, `packages/adapters/src/history-compaction.test.ts`, `memory-context.test.ts`, tests de révocation, `packages/testkit/src/memory-library.postgres.test.ts`, `memory-migration.postgres.test.ts`, `apps/web/e2e/memory-library.spec.ts` et tests Markdown. Ajouter les tests d'adaptateurs déterministes et de jobs réellement interrompus/repris. PostgreSQL valide les transactions ; un double mémoire ne suffit pas.

Exécuter tests ciblés, types et lint des packages touchés. Les E2E Electron qui ouvrent des fenêtres restent en CI. Les E2E web produisent des captures M01–M09, liées dans les PRs ; documenter séparément la recette native.

Évaluation générative : corpus fictif annoté puis corpus autorisé, séparation temporelle calibration/test, comparaison sans mémoire / base actuelle / acquisition sourcée / classement / consolidation. Mesurer fidélité, utilité future, abstention, contradictions, erreurs de rattachement et fusion, temps humain, tokens, coût et latence. Tester en français et sur reformulations des options Jev. Un résultat de benchmark fournisseur ne valide pas le produit.

Bloquants : toute fuite ou promotion de droits dans les tests déterministes ; réapparition d'un dérivé technique retiré ; perte silencieuse de contenu ; incapacité à reprendre. Pour les mesures probabilistes, fixer et documenter les seuils avant le test final ; ne pas déclarer la fonctionnalité prête sur la seule base des 73 fiches de démonstration.

## 5. Documentation et statut de livraison

Ce changement documentaire ne nécessite pas d'entrée de changelog produit. Lors de chaque livraison observable, mettre à jour `CHANGELOG.md` sous la date réelle, documenter le résultat utilisateur et joindre les captures pertinentes. Les PRs UI citent les libellés ajoutés et justifient leur présence. Ne pas déclarer validés le déploiement Docker, les tests ou les nouveaux visuels avant leur exécution effective.
