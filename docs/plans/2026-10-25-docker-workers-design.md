# Workers Docker : pi-native sans E2B et suppression de PiAgentRuntime

Issue : [#317](https://github.com/RomainJeff/rakazo-bot/issues/317).

## Pourquoi

Il reste deux boucles d'agent. Sur E2B, `pi-native` tourne dans un worker par tentative. Partout ailleurs, `PiAgentRuntime` (`packages/adapters/src/pi-runtime.ts`, 2 000 lignes) fait tourner l'ancienne boucle dans le job worker. Chaque comportement est donc écrit et testé deux fois. Un provider worker Docker fait passer l'installation par défaut sur la même architecture qu'E2B, et l'ancienne boucle peut disparaître.

## Décisions

- **Deux providers seulement : `e2b` et `docker`.** `none` et `desktop` disparaissent. La fonction « This Mac », qui laisse un bot piloter directement le Mac de la personne, part avec `desktop`. Les replis silencieux vers `none` de `sandbox-provider-env.ts` (`SANDBOX_PROVIDER` vide, E2B sans clé, Docker en production sans token supervisor) deviennent des erreurs au démarrage.
- **Une seule forme de worker.** Pour Docker, c'est un conteneur par tentative de run, piloté par le supervisor. La piste « pi-native dans le conteneur du computer » est écartée : le harness, hostile par hypothèse, y partagerait la frontière du profil Chrome, et elle casse les runs MCP sans computer ainsi que le démarrage paresseux du computer. La piste « pi-native in-process » n'a plus de raison d'être sans `none` ni `desktop`.
- **Les volumes Docker sont des dossiers du stockage `DATA_DIR`.** On garde le contrat P1 tel quel : le dossier s'appelle `rakazo-<volumeId>` et c'est la table `volumes` qui le relie au bot ou à l'espace.
- **Isolation : runc durci**, avec la même base que le conteneur computer. gVisor reste un ajout possible plus tard, sans rien changer à l'architecture.
- **Pas de pool chaud.** On mesure d'abord, et on n'en ajoute un que si le cold start dépasse nettement celui d'E2B (environ 2,1 s, #262).
- **Pas de rollback.** Une fois un home passé sur volumes, il y reste.
- **Le runtime `scripted` reste en in-process, réservé aux tests** (voir plus bas).

## Architecture

```
api / job worker ──HTTP──▶ supervisor ──socket──▶ dockerd
   DockerWorkerProvider      /workers + exec         conteneur rakazo/worker (sleep <ttl>)
   GuestConnector ◀── HTTP Upgrade, flux d'octets ──▶ exec : node agent-run-worker.mjs
```

- **Le supervisor reste le seul à avoir le socket Docker.** Il gagne trois routes, protégées par le token supervisor existant :
  - `POST /workers` crée le conteneur ;
  - `DELETE /workers?attempt=` le supprime ;
  - `GET /workers/:id/guest` est un upgrade HTTP. Le supervisor y lance `node agent-run-worker.mjs` par `docker exec`, avec `RAKAZO_WORKER_CAPABILITY` dans l'environnement, et branche le socket sur stdin et stdout. Il sépare stdout et stderr avec `demuxStream`, sans TTY.
- **Pourquoi `exec` et pas le process principal du conteneur.** La capability n'existe qu'au moment de `connect`, après `ensure`, et E2B lance aussi le guest à ce moment-là (`e2b-worker.ts:348`). Le process principal du conteneur est donc `sleep <ttlSeconds>`, avec `Init: true` et `AutoRemove`.
- **Pourquoi pas de WebSocket.** Les frames sont déjà des lignes base64 (`runtime-worker/framing.ts`). Le socket obtenu après l'upgrade va directement dans `streamChannel`, sans nouvelle dépendance.
- **`DockerWorkerProvider`** (`packages/adapters/src/docker-worker.ts`) implémente `WorkerProvider` et `GuestConnector`, sur le modèle d'`e2b-worker.ts`.

| E2B | Docker |
|---|---|
| Sandbox depuis un template | Conteneur depuis l'image `rakazo/worker` |
| Tag `metadata.attemptId` | Label `rakazo.attempt=<attemptId>` |
| `timeoutMs` | Process principal `sleep <ttlSeconds>` et `AutoRemove` |
| `Volume` nommé | Dossier `volumes/rakazo-<volumeId>` du stockage, monté aux chemins du `WorkerSpec` |
| Guest lancé par envd en stdin/stdout | Guest lancé par `docker exec`, relayé par le supervisor après un upgrade HTTP |
| `readOnlyMounts: false` | `readOnlyMounts: true` (`:ro`) |

- **Aucun balayage au démarrage du supervisor.** Le TTL et `AutoRemove` bornent la vie de chaque conteneur, et `lifecycle.reconcile` détruit déjà les orphelins par tag de tentative. Un balayage tuerait les workers vivants à chaque redémarrage du supervisor.
- **La composition ne change pas de forme.** `SANDBOX_PROVIDER=docker` compose les workers Docker, comme `e2b` compose les workers E2B depuis P6.

## Volumes

- **`ensureVolume` et `deleteVolume` tournent dans le provider**, côté api et job worker, avec l'uid 1000, sous `DATA_DIR/volumes/`. Ces deux services montent déjà `/data`, et `LocalWorkerProvider` fait déjà la même chose. Le supervisor, qui tourne en root, ne crée et ne supprime jamais un dossier que le guest peut écrire, ce qui évite le risque des symlinks.
- **Le supervisor reçoit seulement des noms de volume.** Il les valide contre `rakazo-<id>` et calcule lui-même les chemins, comme `computerHomeStorage`. Il sait déjà monter un sous-dossier de son stockage, que `DATA_DIR` soit un dossier de l'hôte (bind, `docker-compose.yml`) ou un volume nommé (`appdata` avec `Subpath`, `docker-compose.topology.yml`).
- **Le computer Docker garde `/home/rakazo` sur le bind existant `homes/<botId>`**, pour les dotfiles et le profil Chrome (`.browser-profiles`), sans étape d'archivage. Les volumes sont montés aux chemins `/workspace` du `WorkerSpec`. Comme sur E2B, la racine du workspace devient celle des volumes : `/workspace` pour un computer d'équipe, `/workspace/bots/<botId>` pour un computer dédié. Les chemins relatifs ne changent donc pas. `HOME` reste `/home/rakazo`, et `/home/rakazo/workspace` pointe vers la racine. Le supervisor apprend la racine et un digest des montages par des labels du conteneur (`rakazo.workspace`, `rakazo.mounts`) : un computer dont les montages changent est remplacé.
- **La migration des homes Docker est un `rename` sur le même stockage**, pas la copie vérifiée. `DATA_DIR/homes` et `DATA_DIR/volumes` sont sur le même stockage, un bind ou le volume nommé `appdata`. `homes/<key>/bots/<botId>` devient `volumes/rakazo-<idVolumePrivé>` et `homes/<key>/shared` devient `volumes/rakazo-<idVolumeEspace>`. Un home dédié déplace une à une ses entrées de premier niveau, sauf celles qui commencent par un point, qui restent sur le bind du home. Rien ne reste derrière : les liens et les fichiers spéciaux partent tels quels, et la question de `leaveUnmapped` ne se pose pas. Un lien ou un fichier à la place d'un dossier d'équipe part dans le volume, sans le remplacer, si bien qu'un volume reste toujours un vrai dossier. Le `rename` ne suit jamais un lien. Tous les conflits sont vérifiés d'abord, puis le computer adopte ses volumes sous la réservation de déplacement, renouvelée au besoin, et seulement ensuite viennent les `rename` : un computer ne démarre jamais sur un home à moitié déplacé. Un déplacement interrompu après l'adoption laisse le reste dans le home, et le passage suivant, qui visite aussi les computers déjà sur volumes, le termine. Un home en conflit avec son volume est journalisé et sauté ; seuls des homes et des volumes sur des systèmes de fichiers différents arrêtent `migrate`. Il n'y a pas de `VolumeFiles` locale. La migration E2B garde sa copie vérifiée.

## Isolation

Le conteneur worker reprend la base de `computer-spec.ts` (`CapDrop ALL`, `no-new-privileges`, limites mémoire, CPU et pids) et ajoute :

- l'uid 1000. Le rootfs reste en écriture, comme sur E2B : la couche disparaît avec le conteneur, et `pip --user` ou `git config` continuent de fonctionner ;
- aucun socket, aucun secret dans l'environnement, aucun montage en dehors des volumes de la spec ;
- un réseau bridge `rakazo-workers`, créé avec `enable_icc=false` et non attaché au réseau Compose :
  - deux workers ne peuvent pas se joindre ;
  - le worker ne résout ni `postgres`, ni `api`, ni `supervisor`, et l'api n'est publiée que sur `127.0.0.1` de l'hôte ;
  - le worker n'a besoin de joindre personne chez nous, puisque les frames et le relais du modèle passent par l'exec ;
  - l'egress vers internet reste ouvert, comme sur E2B.

Ces points sont prouvés par un test Docker marqué comme tel, avec du code lancé depuis le worker. Les attaques reprennent la liste d'I1 : montages directs, identifiants devinés, liens et traversée de chemins. Les cibles sont le volume privé d'un autre bot, le volume partagé d'un autre espace, le socket, le token, la base, les ports d'un autre worker et le refus du modèle hostile (lane `e-refusals`). `runtime-worker-hostile.test.ts` couvre déjà le reste au niveau du contrôleur.

## Image

L'image `rakazo/worker` contient exactement ce que contient le template E2B (`apps/agent-run-worker/template/template.ts`) : Node 24, bash, ca-certificates, git, procps, ripgrep, fd-find, `/workspace`, `/managed-skills` et le bundle guest. Elle est construite par le même Compose et le même pipeline d'images que `rakazo/app`, avec le même tag de version. La version du guest vérifiée au handshake reste donc cohérente par construction.

## Ce qui disparaît

- **`PiAgentRuntime`** : la classe, les suites qui la construisent, `pi-live-eval*.ts`, `pi-sdk-bench.ts`, et le chemin `in_process` de l'exécuteur pour les vrais runs.
- **Ce qui doit être déplacé avant**, parce que le relais et `pi-native.ts` l'importent depuis `@rakazo/adapters/pi-runtime` :
  - `toHistory`, `streamRunModel`, `conversationSessionId`, `DEFAULT_COMPUTER_SCREENSHOTS_TO_KEEP`, `guestRuntimeModel`, `createAgentTextPolicy`, `describeToolActivity` et `stripModelControlTokens` ;
  - l'export de sous-chemin, à renommer ;
  - les suites `transport`, `models`, `control-tokens`, `tool-schema` et `secret-schema`, qui testent ces helpers ;
  - `pi-runtime-limits` reste en place, puisque l'exécuteur l'utilise.
  - `executor-approval-pi`, `executor-secret-pi`, `executor-prompt-prefix` et `runtime-worker-hostile.test.ts` importent aussi `PiAgentRuntime` et sont à adapter.
- **Les trois switches de la checklist provider** : `WORKER_SUPPORT` est supprimé, puisque les deux sortes de computer passent sur volumes ; la contrainte `computers_home_storage_check` accepte `docker` (migration) ; la condition de `createBot` fait naître les computers Docker sur volumes.
- **`none`** : `none-sandbox.ts`, `ComputersUnavailableHint.tsx` et ses traductions.
- **« This Mac »** :
  - `desktop-sandbox*.ts`, `host-aware-sandbox.ts` et `HostComputerPrompt.tsx` ;
  - le garde dans `apps/api/src/router.ts` ;
  - les champs `computerHost` des contrats et de la base, avec une migration qui supprime la colonne ;
  - les specs `host-computer-prompt` et `local-settings`.
- **`AGENT_RUNTIME=pi`** dans les fichiers Compose et `.env.example`.

## Le runtime `scripted`

Les E2E et la topologie tournent avec `ScriptedAgentRuntime`, en in-process. On le garde ainsi, réservé aux tests. L'interface `AgentRuntime` survit de toute façon, puisque le chemin worker en est lui-même une implémentation (`runtime-worker/runtime.ts`). Le seul reste est le court-circuit `capabilities.scripted` de l'exécuteur. On en fera un harness guest le jour où un bug E2E n'aurait été attrapé que par le chemin worker.

## Migration des homes avant la suppression

La tranche 4 supprime le chemin in-process. Un computer dont le home est encore sur snapshots ne pourrait alors plus tourner.

- **Docker** : la migration tourne automatiquement dans le service Compose `migrate`, avant le démarrage de l'api et du job worker. Ce service monte `/data` et tourne avec l'uid 1000 de l'image. Il ne déplace que les computers au repos : arrêtés ou suspendus, sans personne aux commandes et sans bail vivant. Les autres sont déplacés par le job de mise en veille quand ils se suspendent, avant leur prochain démarrage. La tranche 4b ajoute pour Docker le même refus au démarrage que pour E2B, tant qu'un home n'est pas migré.
- **E2B** : l'api refuse de démarrer tant qu'un computer E2B a encore son home sur snapshots, et l'opérateur le migre avec le script de #241. C'est déjà le parcours prévu par P6 : les nouveaux computers E2B naissent sur volumes.

## Spike

Sur une branche `spike/docker-workers`, sans PR, avec des sondes écrites directement sous forme de test Docker, pour pouvoir les reprendre telles quelles dans la tranche 2 :

1. Un run `pi-native` tourne sur Docker en local, avec volume privé et volume partagé, à travers le vrai contrôleur et un `DockerWorkerProvider` minimal.
2. Les mesures : le cold start, de la création du conteneur jusqu'au `hello` du guest (p50 et p95 sur 10 démarrages), et le délai de destruction.
3. Les preuves d'isolation listées plus haut.

Le rapport donne les chiffres, et dit si un pool chaud est nécessaire.

### Résultats (2026-10-25, Docker Desktop sur macOS)

- **Le run fonctionne de bout en bout.** Un run `pi-native` est passé par le vrai contrôleur, avec la fixture `startWorkerRun({ provider })` inchangée. Les fichiers écrits sur le volume privé et sur le volume partagé sont lisibles depuis l'hôte.
- **Démarrage et destruction.** Sur 10 démarrages, il faut 401 à 416 ms en p50 et 428 à 448 ms en p95 entre la création du conteneur et le `hello` du guest. La destruction prend environ 80 ms. E2B demande environ 2,1 s, donc **aucun pool chaud n'est nécessaire**.
- **Isolation : tout passe, sauf un point.**
  - Ce qui passe : les volumes étrangers, les chemins de l'hôte, le socket, les secrets, la résolution de `postgres`, `api` et `supervisor`, les ports d'un autre worker (bloqués par ICC off), et les privilèges (uid 1000, aucune capability, seccomp).
  - L'exception, propre à Docker Desktop : `host.docker.internal` donne accès au localhost du Mac, donc à l'api, au web et à postgres publiés sur `127.0.0.1`. Ces services exigent toujours leur token, leur authentification ou leur mot de passe.
  - Sur Linux, les ports publiés sur `0.0.0.0` (80/443 en prod) sont joignables par la passerelle du bridge, comme depuis internet.
  - **Décision** : on accepte ces deux points au même titre que l'egress ouvert, et la doc d'installation pour macOS et Windows le signale.
- **Corrections pour les tranches 1 et 2 :**
  - l'upgrade du guest passe par l'événement `upgrade` du serveur Node, donc hors Hono : il vérifie le token lui-même et doit avoir son propre test ;
  - il faut récupérer le code de sortie de l'exec et journaliser la fin de stderr, comme le fait `e2b-worker.ts` ;
  - `ensure` doit garder une marge avant sa deadline, comme `E2B_CREATE_MARGIN_MS` ;
  - une seule nouvelle tentative pour les appels idempotents du provider, pour encaisser une connexion keep-alive fermée par le supervisor.
- **Ce qui n'a pas été couvert** : les assertions propres à Linux sont écrites mais n'ont pas tourné, et le montage depuis le volume nommé `appdata` n'a pas été exercé, puisque le supervisor tournait sur l'hôte.

## Tranches

Feature branch `feature/docker-workers`, sauf la tranche 0. Les tranches 1 et 2 ne servent à rien sur `main` sans la tranche 3, ce qui justifie la feature branch.

0. **Supprimer `none` et « This Mac »** : PR directe sur `main`, indépendante du reste. Les replis vers `none` deviennent des erreurs au démarrage, et le CHANGELOG reçoit une entrée `Reverted`.
1. **Supervisor** : routes worker, exec avec upgrade HTTP, réseau `rakazo-workers` sans ICC, image `rakazo/worker` dans le Compose et le pipeline d'images.
2. **`DockerWorkerProvider` et composition** :
   - tests contre un faux supervisor, sur le modèle d'`e2b-worker.test.ts` : aucune création après la deadline, `ensureVolume` qui rend deux fois le même nom, `destroy` sans ref qui rend `absent`, frames dans les deux sens ;
   - test Docker marqué comme tel : fichiers sur les volumes, visibilité et isolation entre workers, nettoyage après une panne, refus du modèle hostile. C'est l'équivalent des lanes `a`, `b`, `c`, `g` et `e-refusals`, sans portage des lanes live.
3. **Computer Docker sur volumes et migration des homes** : montages aux chemins `/workspace`, racine du workspace sur les volumes, migration par `rename` dans `migrate` et à la mise en veille, refus au démarrage pour E2B, et les trois switches. La lane `h` devient un test de la migration par `rename`.
4. **Supprimer `PiAgentRuntime`**, en deux temps :
   - **4a, PR directe sur `main`** : sortir de `pi-runtime.ts` les helpers que le relais et `pi-native.ts` importent, avec leurs tests. C'est un refactor pur, possible tout de suite ;
   - **4b, dans la feature** : supprimer la boucle et `pi-live-eval`, puis ajouter l'entrée CHANGELOG de la feature. Cette partie attend les tranches 0 et 3.

Les tranches 0, 1, 2 et 4a avancent en parallèle. La tranche 3 attend 1 et 2.

## Revue founding-engineer

| # | Recommandation | Décision |
|---|---|---|
| 1 | Lancer le guest par `docker exec` au `connect`, pas comme process principal du conteneur | Acceptée : la capability n'existe qu'au `connect` |
| 2 | Upgrade HTTP en flux d'octets au lieu d'un WebSocket | Acceptée |
| 3 | `ensureVolume` et `deleteVolume` dans le provider, avec l'uid 1000, pas dans le supervisor | Acceptée : le root ne touche jamais un arbre que le guest peut écrire |
| 4 | Pas de balayage au démarrage du supervisor | Acceptée |
| 5 | Garder le rootfs en écriture | Acceptée : même comportement qu'E2B |
| 6 | `enable_icc=false` sur `rakazo-workers` | Acceptée |
| 7 | Image identique au template E2B | Acceptée |
| 8 | Copie vérifiée au lieu d'un `rename`, et migration de chaque déploiement avant la tranche 4 | Acceptée pour E2B, avec refus au démarrage. Revue à la tranche 3 pour Docker : homes et volumes partagent le même stockage, donc un `rename` qui reprend après interruption ne laisse rien derrière, sans copie |
| 9 | Ajouter les deux autres switches, et transformer les replis vers `none` en erreurs au démarrage | Acceptée |
| 10 | `/home/rakazo` reste sur le bind `homes/<botId>`, les volumes vont sous `/workspace` | Acceptée |
| 11 | Liste de suppression complète, avec les helpers et tests à déplacer | Acceptée |
| 12 | `scripted` reste en in-process | Acceptée |
| 13 | Pas de portage des lanes live, mais un test Docker marqué | Acceptée |

## Hors périmètre

gVisor, un pool chaud tant que les mesures ne le demandent pas, le filtrage de l'egress, un harness guest `scripted`, et P6 / `feature/pi-e2b-workers`.
