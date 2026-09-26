# Interfaces de mémoire : modèles observables pour Rakazo

Recherche au **21 septembre 2026**. Quatre interfaces principales et deux contrôles complémentaires ; captures publiques de Mem0 et Letta inspectées visuellement, sans connexion ni modification de compte. Les pages sans date sont qualifiées par leur date de consultation, pas par une date de sortie supposée.

**Recommandation proposée :** commencer par une liste de souvenirs dans un périmètre clair, puis ouvrir le contenu, ses sources et ses changements à la demande. Réserver le graphe à une exploration secondaire. Cette note est une recherche de conception, pas une spécification validée ni une vérification de l’implémentation Rakazo.

## Ce qui est réellement établi

**Capture** signifie qu’un contrôle est visible dans une image officielle ; son fonctionnement n’a pas été testé. **Documentation UI** signifie qu’un parcours est décrit officiellement. **API seulement** ne prouve aucun écran. **Proposition** désigne notre choix de conception, jamais une fonctionnalité attribuée à un fournisseur. « Non établi » ne signifie pas « inexistant ».

| Produit | Organisation et interactions établies | Qualification et limites observables |
| --- | --- | --- |
| Claude | Documentation UI : sujets sélectionnables, lecture, édition, suppression ; mémoire distincte par projet. | La citation d’une ancienne conversation appartient à la recherche de chats ; elle ne démontre pas une source sur chaque souvenir. Pas de diff, d’expiration individuelle ou de validation préalable établis ici. |
| Mem0 | Captures : tableau, recherche, filtres, période, catégories, cycle de vie ; détail et corbeille par ligne. | Sources d’une synthèse et onglet d’historique visibles. Les options exactes du filtre, le contenu de l’historique et la suppression effective ne sont pas testés. |
| Letta | Capture et documentation UI : graphe de fichiers, sélection puis édition et sauvegarde dans un panneau. | Les groupes organisent les fichiers ; ils ne certifient ni leurs affirmations ni leur origine. Pas de parcours d’approbation humaine établi par cet écran. |
| Zep | Documentation UI : graphe avec assistant latéral, étapes de recherche dépliables et mise en évidence des preuves. | Assistant en lecture seule, limité au graphe ouvert ; déploiement limité. Aucun écran de modification ou d’approbation démontré par cette référence. |

## 1. Claude : sujets et contrôle conversationnel

Dans **Settings > Memory**, la rubrique **Topics** mène à un sujet lisible, modifiable ou supprimable. L’utilisateur peut aussi demander un changement dans le chat. Le mode incognito évite d’alimenter mémoire et historique. La pause conserve la mémoire sans l’utiliser ni l’enrichir ; la réinitialisation la supprime, projets inclus. Supprimer une conversation ne supprime pas ses souvenirs dérivés. La page présente le nouveau parcours et conserve une section legacy : ne pas les fusionner. [Documentation mémoire, mention « Updated this week » à la consultation](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context).

L’import suit **Start import → coller le texte → Add to memory**, puis revue des entrées produites. Il s’agit d’une extraction expérimentale, pas d’une copie garantie à l’identique. La rubrique export contient encore le chemin **Settings > Capabilities**, tandis que la même page présente **Settings > Memory** pour le nouveau système : ce parcours exact d’export reste à vérifier. La proposition d’export par conversation n’établit pas son exhaustivité. [Import et export, mention « Updated over 2 weeks ago »](https://support.claude.com/en/articles/12123587-import-and-export-your-memory-from-claude).

**Transposition proposée :** offrir la même correction depuis la conversation et depuis le détail d’un souvenir, avec un résultat observable et une portée explicite.

## 2. Mem0 : fait, état et preuves au même endroit

L’article officiel du **5 août 2026**, actualisé le **6 août**, expose Dream sur des données synthétiques. Le tableau montre recherche textuelle/utilisateur, **Filter**, **All time**, et colonnes temps, entités, contenu, catégories, cycle de vie, action. Les états **Active** et **Superseded** sont visibles. Le détail d’une synthèse montre création/modification, catégories, onglets **Details**, **Input**, **Changelog**, quatre faits sources, métadonnée de synthèse et feedback positif/négatif. [Article et captures Mem0](https://mem0.ai/blog/stale-ai-agent-memory-and-how-mem0-dream-fixes-it).

Captures examinées : [tableau des souvenirs](https://framerusercontent.com/images/aJX33HbGW9GEER3TiLYazGNdU4.png), [détail d’une synthèse](https://framerusercontent.com/images/vlZcdlvtB8UJchd2CaFLIgjbGw.png).

Le texte décrit fusion, remplacement et synthèse automatiques, consultables après traitement. Cela ne démontre pas une admission humaine avant utilisation. Les sources affichées sont ici d’autres souvenirs, pas les extraits bruts de conversations. L’option API `latest_only` ne prouve pas un contrôle équivalent dans l’interface.

**Transposition proposée :** reprendre la séparation entre contenu, cycle de vie et provenance ; afficher les métadonnées techniques uniquement lorsqu’elles aident à comprendre un problème.

## 3. Letta : mémoire éditable comme ensemble de documents

La page actuelle de l’application décrit **Memory** comme un graphe de fichiers qui se référencent ; sélectionner un nœud permet de consulter, modifier et sauvegarder son contenu. Sa capture montre des groupes **Persona**, **Human**, **Project**, **Reference**, **Skills**, un panneau de texte et les commandes **Reset** et **Save**. Une commande de vue liste apparaît aussi, mais son écran n’est pas inspecté. La légende distingue types de nœuds, longueur de fichier et références. [Letta app, documentation consultée le 21 septembre 2026](https://docs.letta.com/platform/desktop-app#memory).

[Capture officielle inspectée](https://docs.letta.com/images/desktop/memory-editing.png). Aucun historique détaillé, comparaison avant/après, expiration ou rattachement à une conversation source n’est établi par cette image. Les anciens exemples d’ADE à blocs et mémoire archivale ne servent donc pas ici de preuve de l’interface actuelle.

**Transposition proposée :** retenir l’édition directe et le détail adjacent ; un graphe documentaire peut aider à explorer une mémoire volumineuse, mais ne dispense pas de montrer ce qui sera réellement utilisé par l’agent.

## 4. Zep : explorer la raison d’une connaissance

Dans le visualiseur d’un graphe utilisateur ou autonome, **Ask graph** ouvre un panneau redimensionnable. L’utilisateur pose une question ; les étapes exposent opération, paramètres et résultat, dépliables. Les preuves citées peuvent être développées et affichées sur le graphe ; sélectionner une entité centre la vue. La documentation permet de chercher les épisodes sources derrière un fait. [Graph visualizer assistant, consulté le 21 septembre 2026](https://help.getzep.com/graph-visualizer-assistant).

L’assistant est disponible progressivement, uniquement dans le dashboard. Il ne modifie aucune donnée, reste dans le graphe ouvert et abandonne la conversation à la fermeture du visualiseur. Le panneau signale aussi les éléments absents du canevas et les résultats abrégés avant lecture par l’assistant. Ce parcours est documenté, sans capture inspectée ni test connecté. Il ne prouve ni validité des faits, ni workflow d’approbation, ni contrôle d’expiration dans cette UI.

**Transposition proposée :** permettre d’ouvrir les preuves d’une réponse et d’un souvenir sans imposer le graphe pour une correction ordinaire.

## Contrôles complémentaires : ne pas confondre revue et exclusion

Supermemory documente une file de souvenirs inférés avec approbation, rejet et annulation. Toutefois, avant approbation, ces souvenirs sont **moins bien classés dans la recherche**, pas exclus. La revue change donc le classement ; elle ne constitue pas à elle seule une barrière préalable au rappel. Pour Rakazo, une file « À examiner » doit correspondre à une exclusion effective de tous les chemins de rappel. [Contrat API de revue](https://supermemory.ai/docs/recall/memory-review).

Mem0 distingue également l'état affiché et le comportement de recherche : une lecture par défaut peut retourner des souvenirs remplacés. Le paramètre `latest_only=True` les exclut. Un badge « remplacé » ne démontre donc pas, à lui seul, que le modèle ne recevra plus l'ancien fait. [Comportement documenté de Dream](https://mem0.ai/blog/stale-ai-agent-memory-and-how-mem0-dream-fixes-it).

Codex documente la séparation entre utilisation et génération de souvenirs, ainsi qu'une option `memories.disable_on_external_context` qui exclut de la génération les sessions ayant utilisé du contexte externe. Il s'agit d'une option documentée, pas d'une protection universelle activée par défaut. Ce mécanisme fournit un exemple concret de traitement conservateur de la provenance. [Documentation officielle des mémoires](https://learn.chatgpt.com/docs/customization/memories).

## Proposition minimale pour Rakazo

Les points suivants sont des choix proposés, à tester avec des exemples fictifs et des besoins réels.

1. **Entrée simple :** une page Mémoire avec recherche et périmètre courant visible. Chaque ligne privilégie l’énoncé ; catégorie, origine et date ne prennent de place que lorsqu’elles permettent de distinguer deux éléments. Commencer sans grille de scores ni compteurs permanents.
2. **Détail vérifiable :** texte, source ouvrable avec extrait exact, auteur de l’écriture et date. Une synthèse renvoie à ses éléments d’origine ; une chaîne de synthèses doit permettre d’atteindre la preuve initiale. Distinguer ce que la source dit de ce que l’agent en conclut.
3. **Qualification séparée :** une catégorie répond à « de quoi parle-t-on ? », la portée à « qui peut l’utiliser ? », le cycle de vie à « est-ce encore utilisé ? ». Une inférence ou une validation humaine constitue une autre propriété. Aucun badge unique ne doit faire passer ces dimensions pour une garantie de vérité.
4. **Correction au bon moment :** une proposition de changement affiche le souvenir concerné et l’écart utile. Si une validation est requise, le souvenir proposé reste exclu du rappel jusqu’à la décision. Un examen après enregistrement doit être nommé autrement. Afficher une boîte de réception seulement lorsqu’il reste des propositions à traiter.
5. **Temps et retrait :** distinguer correction d’erreur, nouvelle situation et fin de validité. Proposer une échéance quand le contenu est temporaire. Expliquer l’effet du retrait au moment de l’action, notamment lorsque source, souvenir et synthèse dérivée ont des durées de conservation différentes.

Premier test utile : retrouver un souvenir précis, comprendre sa source, corriger une inférence, remplacer une préférence devenue obsolète, puis vérifier qu’un élément retiré n’influence plus une nouvelle réponse. Mesurer la réussite de ces tâches avant d’ajouter un graphe ou une taxonomie plus détaillée.
