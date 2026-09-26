# Mémoire — recette fonctionnelle des cas limites

24 septembre 2026. Recette réalisée dans le navigateur intégré, sur l'application Docker locale et la session connectée. Les créations, modifications, imports, classements, consolidations et retraits ont été effectués par l'interface, sans appel RPC direct ni préparation de données en base.

**Conclusion : les contrôles de statut et de concurrence testés résistent, mais le parcours n'est pas prêt à être déclaré sans défaut.** Les priorités sont le double import, la traçabilité après consolidation, les erreurs cachées et les mémoires vides. Aucun correctif produit n'a été appliqué pendant cette recette.

## Défauts reproduits

### F01 — Le double clic d'import crée deux propositions (P2)

Parcours : Personnel → menu mémoire → Paste OKF text → coller un document valide → double-cliquer Import.

Résultat : deux lignes portant le même titre et le même contenu, avec deux identités de document distinctes. Le cas utilise `QA-EDGE-2409 · Double import`. Ce n'est pas une réimportation volontaire : un seul formulaire a été soumis par un double clic.

Attendu : une seule commande logique, bouton occupé et clé d'idempotence conservée pendant l'opération. Point confirmé dans `apps/web/src/pages/MemoryLibraryPage.tsx`, fonction `importOkfContent` : la clé est recréée à chaque appel et aucun verrou d'import n'empêche la seconde soumission.

### F02 — Les sources disparaissent après acceptation d'une synthèse (P2)

Parcours : sélectionner deux mémoires actives → Continue → proposer une synthèse → Replace sources → ouvrir Details → recharger.

Résultat : les deux sources sont visibles pendant la proposition, puis la section Sources disparaît après acceptation, y compris après rechargement. Les originaux ne sont plus dans la liste Active. Leur ancienne URL reste lisible, mais leur état remplacé n'est pas expliqué dans la fiche. Cette recette établit une perte de traçabilité dans l'interface, pas une suppression des preuves en base.

Cause confirmée dans `MemoryDetail` : `isConsolidation` impose `document.status === "proposed"` et conditionne aussi l'affichage des sources. Séparer l'identification d'une synthèse de son éligibilité aux boutons d'acceptation.

### F03 — L'erreur d'import est derrière la fenêtre (P2)

Parcours : Paste OKF text → saisir deux clés `type` → Import.

Résultat : la fenêtre reste ouverte avec le texte, sans erreur lisible en son sein. La capture montre « Could not import OKF » dans la page floutée derrière le dialogue ; l'arbre d'accessibilité du dialogue ne la contient pas. Même retour avec type absent, profil inconnu et alias YAML.

Attendu : une erreur courte dans la fenêtre, liée au champ, indiquant au moins le défaut de format. Le service refuse l'import, mais l'utilisateur ne sait pas quoi corriger. `importOkfContent` remplit l'erreur de la bibliothèque plutôt qu'une erreur du dialogue.

### F04 — Une mémoire composée uniquement d'espaces devient active (P2)

Parcours : Add memory → saisir des espaces et un saut de ligne → Save.

Résultat : création d'une mémoire active intitulée Untitled memory. Le même éditeur désactive correctement Save quand le champ est réellement vide. La consolidation, elle, désactive correctement la soumission pour un texte blanc.

Attendu : refuser un contenu dont `trim()` est vide dans le contrat/service et dans l'éditeur, sans modifier le Markdown valide. Le bouton de l'éditeur vérifie actuellement `!content`, pas `!content.trim()`.

### F05 — Un identifiant de traduction apparaît dans la classification (P2)

Parcours : ouvrir une mémoire ayant un doublon actif → Details → Review classification.

Résultat : `WRE3Qt` apparaît au-dessus de la relation `duplicate`, confirmé visuellement. Le code utilise `Related memories`, absent du catalogue anglais examiné. Régénérer et compiler les catalogues avant la construction, puis vérifier l'image effectivement déployée.

### F06 — Le conflit de versions n'est pas expliqué (P2)

Parcours : ouvrir la même mémoire en édition dans deux onglets ; enregistrer B ; modifier puis enregistrer A.

Résultat : le serveur refuse A et son brouillon reste intact. Mais le seul message est « Could not save. Your draft is still here. » Aucun renseignement sur le conflit ni action de rechargement/comparaison n'est proposé. Le contrôle de concurrence fonctionne ; sa résolution par l'utilisateur reste incomplète.

### F07 — La neuvième sélection est silencieusement ignorée (P3)

Parcours : sélectionner huit mémoires, puis cliquer la neuvième case.

Résultat : la neuvième case paraît disponible, reçoit le focus, mais reste décochée ; Continue reste à huit, sans explication. La borne est respectée mais devrait être visible, par exemple en désactivant les cases restantes avec un nom accessible approprié.

### F08 — Les filtres contredisent l'état de la fiche après acceptation (P3)

Après Replace sources, la synthèse devient active mais l'URL et l'onglet sélectionné restent sur Proposals. Un filtre de recherche hérité des sources peut afficher « Nothing remembered yet » derrière la synthèse nouvellement créée. Le même texte est employé pour une bibliothèque réellement vide et pour zéro résultat de recherche.

Attendu : conserver un contexte compréhensible, afficher l'état réel de la fiche et distinguer absence de résultat et absence de mémoires. Ne pas laisser le filtre sélectionné faire office de statut implicite du document.

### F09 — L'audience de publication n'est pas nommée (P3)

La fenêtre Share memory dit seulement « With your Space ». Dans une session ayant plusieurs espaces, ni le nom ni un autre identifiant lisible de l'espace destinataire n'est affiché. La publication de test est arrivée dans la collection partagée de l'espace courant ; la destination devrait être explicite avant de confirmer.

## Matrice des parcours exécutés

« Conforme » désigne uniquement le résultat visible de ce scénario. Cette recette n'est pas une nouvelle exécution des tests PostgreSQL ou du moteur de rappel.

| Cas | Résultat observé |
| --- | --- |
| Menu utilisateur → mémoire personnelle | Conforme, périmètre Personal sélectionné |
| Création avec champ vraiment vide | Save désactivé |
| Création avec espaces seuls | Échec F04 |
| Markdown Unicode, accents, emoji, tableau, case à cocher | Rendu conservé ; case de rendu non interactive |
| Balise script dans le Markdown | Aucune exécution observée, pas de dialogue JavaScript |
| Lien `javascript:` | Destination neutralisée : attribut href vide |
| Balise image avec gestionnaire d'événement | Affichée comme texte, aucune exécution observée |
| Abandon d'un brouillon | Contenu enregistré conservé ; réserve sur le dialogue natif, voir limites |
| Deux éditions concurrentes | Deuxième version obsolète refusée, brouillon conservé ; F06 |
| Import avec clé YAML dupliquée | Refus, formulaire conservé ; F03 |
| Import sans type | Refus ; F03 |
| Import avec profil inconnu | Refus ; F03 |
| Import utilisant un alias YAML | Refus ; F03 |
| Import valide avec statut active, approved et permissions dans les métadonnées | Reste une proposition avec bouton Accept |
| Édition de cette proposition | Reste une proposition |
| Double clic sur Import | Deux propositions, F01 |
| Recherche de neuf sources fictives | Neuf lignes attendues, pas de mélange avec les autres documents |
| Consolidation avec zéro ou une sélection | Pas de bouton Continue |
| Consolidation avec deux sélections | Accès à la revue, bonnes sources affichées |
| Consolidation avec huit puis neuf sélections | Borne huit conservée ; retour utilisateur F07 |
| Changement de recherche pendant une sélection | Sélection et mode de consolidation réinitialisés |
| Deux contenus identiques → Review classification | Relation duplicate proposée |
| Application explicite de type Project et nature decision | Métadonnées affichées après enregistrement |
| Texte de relation du classement | Défaut de traduction F05 |
| Synthèse composée d'espaces | Propose synthesis désactivé |
| Proposition de synthèse avec exception dans le texte | Exception conservée, sources visibles avant acceptation |
| Source modifiée après création de la proposition | Replace sources refusé, erreur de source modifiée affichée |
| Remplacement avec sources intactes | Synthèse activée, originaux retirés de la liste Active |
| Revue des sources après acceptation et rechargement | Échec F02 |
| Navigation de la fiche après acceptation | Ambiguïté F08 |
| Publication d'un extrait modifié, sans cocher Attach this excerpt | Seul l'extrait choisi est visible ; aucune citation privée dans Details |
| Retrait de l'original privé | Publication indépendante toujours active et lisible |
| Édition de l'original retiré | Ne le restaure pas ; bouton Restore conservé |
| Périmètre Agent avec All agents | Add memory désactivé |
| Création pour Atlas puis recherche chez Nova | Aucune note Atlas dans Nova |
| Recherche de cette note dans Space | Aucune note Atlas ; seule la publication explicite de test apparaît |
| Retrait des données de recette | 17 documents de test retirés, contrôle visible de Restore ; recherche personnelle active sans résultat de test |

## Dates : résultat non concluant

Deux tentatives ont affiché une période inversée dans les contrôles après remplissage automatisé, puis la fiche enregistrée n'affichait pas ces dates. Le remplissage d'un champ vide a également montré une différence entre l'opération d'automatisation et une saisie au clavier pendant la recette de recherche. Il n'est donc pas établi que le formulaire React ait reçu les valeurs des dates.

Une tentative au clavier sur le contrôle natif de date a fait planter l'onglet du navigateur intégré. Ses autres onglets restaient utilisables. Ne pas conclure que Rakazo accepte des périodes inversées, ni que le plantage vient de Rakazo. Rejouer ce scénario manuellement, puis dans un test navigateur qui vérifie la valeur envoyée et la persistance. Aucune protection du navigateur n'a été contournée pour poursuivre cette branche.

## Limites et état final

- Une seule identité connectée utilisée. La séparation entre collections d'agents a été observée, mais pas l'autorisation entre deux personnes distinctes ni une révocation d'appartenance en plein traitement.
- Aucun appel à un agent génératif pour mesurer le rappel ou l'obéissance à une injection. Un import restant proposé et un script Markdown neutralisé ne suffisent pas à certifier l'absence de context poisoning.
- Pas de recette de modèle Jev réel, de compaction longue, de panne réseau, d'import de fichier par le sélecteur natif, de téléchargement OKF ou de vue mobile dans cette passe. Les imports ont utilisé le chemin texte.
- L'abandon par Cancel a parfois produit un délai du pilote de navigateur autour du dialogue natif ; la fiche revenait au contenu enregistré. La qualité de ce dialogue n'est pas déclarée validée.
- Les captures affichées durant la recette ont confirmé les erreurs masquées et le libellé technique. Elles ne sont pas des captures CI et aucun chemin de fichier persistant n'est revendiqué ici.
- Dix-sept données fictives marquées `QA-EDGE-2409` ont été créées puis retirées via l'interface, sans suppression définitive ni modification des documents de démonstration existants. Elles restent dans l'historique et le filtre Withdrawn pour reproduction.
- L'onglet initial a retrouvé son écran de départ. L'onglet de recette normal a été fermé ; le pilote n'a pas pu fermer celui qui avait planté sur le champ date.

Le [bilan d'implémentation précédent](2026-09-24-memory-implementation-validation.md) décrit des tests ciblés passants ; cette recette exploratoire apporte des régressions et lacunes supplémentaires à corriger, sans annuler ces résultats techniques.
