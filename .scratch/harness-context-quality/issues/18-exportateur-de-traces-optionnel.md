# 18: Exportateur de traces optionnel (Langfuse) — décision avant code

**What to build:** Un opérateur qui pose une paire de clés Langfuse dans son environnement voit ses runs d'agent apparaître comme des traces arborescentes — run, tours, appels d'outils, compaction — sans que le dépôt dépende de Langfuse et sans qu'un déploiement qui ne pose rien change de comportement.

Le cadrage complet est dans `../langfuse-observabilite.md`. Deux choses à savoir avant de lire la suite, toutes deux vérifiées :

**Le contrat neutre n'est pas à écrire, il existe.** `@earendil-works/pi-telemetry` est déjà dans le graphe de dépendances et fournit spans, no-op, adaptateur de référence, schémas typés et suite de conformance, sans exportateur ni dépendance à un backend. Le ticket 17 le câble. Ce ticket n'ajoute donc qu'un adaptateur au bout, pas une couche d'abstraction.

**Une extension Langfuse pour pi existe déjà, mais pas pour cet usage.** `@langfuse/pi-observability-plugin`, publiée par Langfuse, est expérimentale et se branche sur l'API d'extension du **CLI** `pi-coding-agent` — dont ce dépôt ne dépend pas, puisqu'il pilote `pi-agent-core` directement. Elle n'est pas installable telle quelle ici — mais sa surface d'accrochage est minuscule, et c'est le fait marquant de ce ticket.

Le plugin est **une seule fonction qui reçoit un objet hôte**. De cet hôte il n'utilise que deux méthodes — abonnement aux événements et exécution d'une commande — et, dans le contexte passé à chaque handler, cinq champs : répertoire courant, présence d'une UI, modèle (id et provider), et un gestionnaire de session dont il tire l'identifiant et les entrées. Rien d'autre. Un objet de compatibilité d'une centaine de lignes, qui réémet les événements du runtime de ce dépôt vers cette fonction, suffirait donc à récupérer les mille lignes de cartographie sans les écrire.

Deux réserves à vérifier avant de parier dessus. D'abord, sur les treize événements qu'il écoute, seuls ceux du cœur agent existent ici (fin de message, début et fin d'exécution d'outil) ; les événements de cycle de vie de session et de pré-requête appartiennent au CLI et devraient être **synthétisés** par l'adaptateur — c'est là que se cache le vrai travail, et c'est aussi là que se cache le risque de divergence à chaque version du plugin. Ensuite, il tire `@langfuse/otel` et le SDK OpenTelemetry dans les dépendances directes, ce que ce dépôt n'a pas aujourd'hui, et son peer sur le CLI n'est pas versionné. Elle reste précieuse à deux titres : c'est la cartographie de référence pi → Langfuse (traces, generations, appels d'outils, images, sous-agents), elle est sous licence MIT, et elle écoute **exactement les mêmes événements** que le runtime de ce dépôt (`message_update`, `message_end`, `tool_execution_start`, `tool_execution_end`, compaction). La logique de traduction est donc lisible et portable ; ce qui ne l'est pas, c'est son point d'accroche. Sa configuration est aussi un précédent utile : deux clés requises, hôte par défaut, étiquettes optionnelles d'environnement et d'utilisateur.

Restent les décisions, inchangées par ces deux constats :

1. **Que sort-il vers le tiers ?** Métriques seules ; métadonnées plus contenu expurgé ; ou contenu complet. La redaction existante protège des secrets techniques à motif connu, pas de la vie privée : la mémoire injectée et les sorties d'outils (un fichier lu, une page web) partiraient telles quelles. Le code existant penche deux fois vers les métriques seules, et le schéma pi va dans le même sens en recommandant de tenir prompts, complétions et sorties d'outils hors des attributs. Noter que l'extension Langfuse, elle, trace les prompts et les sorties par défaut : reprendre sa cartographie sans reprendre sa politique est un choix à faire consciemment. Le mode contenu n'est pas une nouvelle capacité — le transcript JSONL local trace déjà le contenu — c'est un **nouveau destinataire**, donc une question de gouvernance, et il implique de mettre le tiers dans le parcours de consentement documenté.
2. **Le `userId` sort-il ?** Opaque, haché, ou omis. Aucune des trois n'est neutre : sans lui, plus de filtre « qu'est-il arrivé à cet utilisateur » ; avec lui, une donnée personnelle chez un tiers.
3. **Faut-il ce ticket du tout ?** Après le ticket 17, ce que Langfuse apporte en exclusivité se réduit à une interface de navigation arborescente et, en mode contenu, à la relecture cross-run. Aucun des deux n'est un besoin exprimé par les tickets 01–17. **Ne pas ouvrir ce ticket tant qu'un besoin concret n'est pas apparu que les logs, `Event` et `UsageRecord` ne couvrent pas.**

Si la décision est « oui », la forme est déjà déterminée par le dépôt : l'exportateur Axiom optionnel est le patron à copier trait pour trait — lecture d'environnement, config partielle qui logue un warning unique et reste éteinte, no-op total si rien n'est posé, installation au point de composition, test offline avec client injecté. Les garde-fous de sink existent déjà, donc « ne jamais faire échouer un run » est acquis. La clé de corrélation est le `runId`, déjà porté comme identifiant de trace et déjà en base.

Un arbitrage technique reste ouvert : le SDK Langfuse v5 est bâti sur OpenTelemetry et ferait entrer cette pile dans le graphe direct, alors que ce dépôt ne l'utilise pas en propre. Une porte de sortie existe, l'adaptateur du ticket 17 étant neutre : exporter en OTLP sans SDK propriétaire. Contrat et format de l'endpoint OTLP de Langfuse à confirmer avant d'en faire une option.

Deux réserves à ne pas perdre si le code s'écrit : les messages d'historique rejoués sont de l'**entrée de trace, jamais des generations** — ils portent le modèle du run courant et un usage à zéro, donc exportés naïvement ils s'affichent comme des appels gratuits sous un modèle qui ne les a pas produits. Et aucune signature d'API ni aucun nom de variable n'est figé ici ; ils sont à lire dans la doc de la version retenue.

**Blocked by:** 17 (qui câble le contrat de télémétrie ; le critère d'ouverture est qu'un besoin subsiste après lui)

**Status:** needs-decision — trois décisions du mainteneur avant tout code

- [ ] Le mainteneur a tranché la politique de données par défaut et l'a écrite dans le cadrage
- [ ] Le mainteneur a tranché le sort du `userId`
- [ ] Le mainteneur a confirmé, après le ticket 17, qu'un besoin concret subsiste — sinon ce ticket est clos avec ce constat, sans code
- [ ] Si le code s'écrit : la voie « objet de compatibilité autour du plugin publié » a été comparée à « adaptateur maison sur le contrat de télémétrie », et le choix est écrit avec sa raison
- [ ] Si le code s'écrit : rien posé en environnement = aucun import du SDK exécuté, aucun appel réseau, aucun changement de comportement
- [ ] Si le code s'écrit : config partielle = un warning unique au démarrage, exportateur éteint
- [ ] Si le code s'écrit : une panne du tiers ne fait jamais échouer un run ni retenir l'arrêt du process
- [ ] Si le code s'écrit : variables documentées dans la doc self-host et entrée CHANGELOG, le comportement étant observable par l'opérateur
