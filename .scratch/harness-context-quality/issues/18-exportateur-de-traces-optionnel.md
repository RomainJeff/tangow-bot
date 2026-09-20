# 18: Exportateur de traces optionnel (Langfuse) — décision avant code

**What to build:** Un opérateur qui pose une paire de clés Langfuse dans son environnement voit ses runs d'agent apparaître comme des traces arborescentes — run, tours, appels d'outils, compaction — sans que le dépôt dépende de Langfuse et sans qu'un déploiement qui ne pose rien change de comportement.

Le cadrage complet est dans `../langfuse-observabilite.md`. Deux choses à savoir avant de lire la suite, toutes deux vérifiées :

**Le contrat neutre n'est pas à écrire, il existe.** `@earendil-works/pi-telemetry` est déjà dans le graphe de dépendances et fournit spans, no-op, adaptateur de référence, schémas typés et suite de conformance, sans exportateur ni dépendance à un backend. Le ticket 17 le câble. Ce ticket n'ajoute donc qu'un adaptateur au bout, pas une couche d'abstraction.

**Une extension Langfuse pour pi existe déjà, mais pas pour cet usage.** `@langfuse/pi-observability-plugin`, publiée par Langfuse, est expérimentale et se branche sur l'API d'extension du **CLI** `pi-coding-agent` — dont ce dépôt ne dépend pas, puisqu'il pilote `pi-agent-core` directement. Elle n'est pas installable telle quelle ici — mais sa surface d'accrochage est minuscule, et c'est le fait marquant de ce ticket.

Le plugin est **une seule fonction qui reçoit un objet hôte**. De cet hôte il n'utilise que deux méthodes — abonnement aux événements et exécution d'une commande — et, dans le contexte passé à chaque handler, cinq champs : répertoire courant, présence d'une UI, modèle (id et provider), et un gestionnaire de session dont il tire l'identifiant et les entrées. Rien d'autre. Un objet de compatibilité d'une centaine de lignes, qui réémet les événements du runtime de ce dépôt vers cette fonction, suffirait donc à récupérer les mille lignes de cartographie sans les écrire.

Deux réserves à vérifier avant de parier dessus. D'abord, sur les treize événements qu'il écoute, seuls ceux du cœur agent existent ici (fin de message, début et fin d'exécution d'outil) ; les événements de cycle de vie de session et de pré-requête appartiennent au CLI et devraient être **synthétisés** par l'adaptateur — c'est là que se cache le vrai travail, et c'est aussi là que se cache le risque de divergence à chaque version du plugin. Ensuite, il tire `@langfuse/otel` et le SDK OpenTelemetry dans les dépendances directes, ce que ce dépôt n'a pas aujourd'hui, et son peer sur le CLI n'est pas versionné. Elle reste précieuse à deux titres : c'est la cartographie de référence pi → Langfuse (traces, generations, appels d'outils, images, sous-agents), elle est sous licence MIT, et elle écoute **exactement les mêmes événements** que le runtime de ce dépôt (`message_update`, `message_end`, `tool_execution_start`, `tool_execution_end`, compaction). La logique de traduction est donc lisible et portable ; ce qui ne l'est pas, c'est son point d'accroche. Sa configuration est aussi un précédent utile : deux clés requises, hôte par défaut, étiquettes optionnelles d'environnement et d'utilisateur.

## Décisions du mainteneur — prises

Les trois arbitrages ci-dessous sont tranchés. Ils ne sont plus ouverts ; ce qui suit dans ce ticket les décrit, il ne les rediscute pas.

1. **Contenu complet.** Prompts, réponses, arguments et sorties d'outils partent vers le tiers, comme le fait l'extension publiée par défaut. C'est le mode qui donne la relecture cross-run complète.
2. **`userId` brut.** L'identifiant sort tel quel, non haché, pour rester exploitable dans l'interface du tiers.
3. **Adaptateur maison.** L'export s'écrit sur le contrat de télémétrie déjà présent dans le graphe de dépendances, en OTLP, sans dépendre du CLI pi ni de l'extension publiée. Celle-ci reste la référence de cartographie à lire, pas une dépendance.

### Ce que la décision 1 entraîne mécaniquement

Ce dépôt a déjà un mécanisme de consentement par destinataire : une table de consentements clée par `recipientKey`, un helper qui dérive une clé stable et un nom affichable à partir du couple usage/fournisseur, un statut exposé par l'API, et un vocabulaire d'usages fermé (`model`, `memory`, `voice`). Tout destinataire de données personnelles y passe.

Un exportateur qui envoie du contenu de conversation **est** un destinataire de ce type. Il ne peut donc pas se contenter de lire deux clés d'environnement et d'émettre : il doit entrer dans ce mécanisme comme les autres — un nouvel usage dans le vocabulaire, un destinataire dérivé de l'endpoint, un statut visible par l'utilisateur, et une **porte à l'émission** qui n'exporte le contenu que pour les utilisateurs ayant consenti à ce destinataire.

Conséquences de portée, à prendre en compte dans l'estimation : cela touche le schéma de données, les contrats, l'API de statut, la surface où l'utilisateur accorde son consentement, et le chemin d'export lui-même. Ajouter un destinataire n'invalide pas les consentements existants — ils sont versionnés, et une clé nouvelle est simplement non accordée par défaut — donc aucune migration de consentement n'est nécessaire.

Ce que la porte implique aussi : pour un utilisateur qui n'a pas consenti, l'export **ne tombe pas silencieusement en mode métriques**. Le comportement attendu — ne rien exporter du tout pour cet utilisateur, ou exporter la trace sans contenu — est à décider à l'implémentation et à écrire dans le ticket, pas à improviser.

La décision 2 vit sous la même porte : l'identifiant brut est une donnée personnelle, il sort avec le reste ou pas du tout.

La forme est déjà déterminée par le dépôt : l'exportateur Axiom optionnel est le patron à copier trait pour trait — lecture d'environnement, config partielle qui logue un warning unique et reste éteinte, no-op total si rien n'est posé, installation au point de composition, test offline avec client injecté. Les garde-fous de sink existent déjà, donc « ne jamais faire échouer un run » est acquis. La clé de corrélation est le `runId`, déjà porté comme identifiant de trace et déjà en base.

Un arbitrage technique reste ouvert : le SDK Langfuse v5 est bâti sur OpenTelemetry et ferait entrer cette pile dans le graphe direct, alors que ce dépôt ne l'utilise pas en propre. Une porte de sortie existe, l'adaptateur du ticket 17 étant neutre : exporter en OTLP sans SDK propriétaire. Contrat et format de l'endpoint OTLP de Langfuse à confirmer avant d'en faire une option.

Deux réserves à ne pas perdre si le code s'écrit : les messages d'historique rejoués sont de l'**entrée de trace, jamais des generations** — ils portent le modèle du run courant et un usage à zéro, donc exportés naïvement ils s'affichent comme des appels gratuits sous un modèle qui ne les a pas produits. Et aucune signature d'API ni aucun nom de variable n'est figé ici ; ils sont à lire dans la doc de la version retenue.

**Blocked by:** 17

**Status:** ready-for-agent — les trois décisions sont prises et écrites plus haut

- [ ] la voie « objet de compatibilité autour du plugin publié » a été comparée à « adaptateur maison sur le contrat de télémétrie », et le choix est écrit avec sa raison
- [ ] rien posé en environnement = aucun import du SDK exécuté, aucun appel réseau, aucun changement de comportement
- [ ] config partielle = un warning unique au démarrage, exportateur éteint
- [ ] une panne du tiers ne fait jamais échouer un run ni retenir l'arrêt du process
- [ ] variables documentées dans la doc self-host et entrée CHANGELOG, le comportement étant observable par l'opérateur
- [ ] L'exportateur est déclaré comme destinataire dans le mécanisme de consentement existant, avec un usage nommé et un nom affichable dérivé de l'endpoint
- [ ] Aucun contenu ni identifiant d'un utilisateur qui n'a pas consenti à ce destinataire ne quitte le processus, et le comportement retenu pour ce cas est écrit
- [ ] Le contenu exporté passe par le redacteur de secrets existant avant de partir
