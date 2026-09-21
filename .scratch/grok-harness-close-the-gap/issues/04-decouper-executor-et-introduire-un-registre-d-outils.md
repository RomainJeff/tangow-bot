# 04: Découper `executor.ts` et introduire un registre d'outils

**What to build:** Sortir de `applyTool` les branches d'outils qui n'ont besoin que de leurs arguments et de dépendances explicites, les enregistrer dans un registre indexé par nom, et laisser dans la closure ce qui touche à l'orchestration du run (approbation, lease, effets, rédaction). Le premier lot est petit, isolable et testable seul.

## Cartographie

`packages/adapters/src/executor.ts` fait 5 602 lignes. Structure :

| Bloc | Lignes | Taille |
|---|---|---|
| helpers module (tokenizer shell `:378-510`, `isProtectedComputerLifecycleCommand` `:511`, audit `:614-657`, `buildSystemInstructions` `:841-874`) | `:1-874` | 874 |
| `createRunExecutor` | `:875-4592` | 3 718 |
| dont `continueRun` | `:1121-4591` | 3 470 |
| dont `applyTool` (dans `continueRun`) | `:1860-3618` | 1 759 |
| helpers module (lease `:4654`, `selectBuiltinToolsForRun` `:4671`, `redactBlocks` `:4948`, `recordEffect` `:5210`, `completeEffect` `:5326`, `runSandboxCommand` `:5348-5382`) | `:4592-5602` | 1 010 |

`applyTool` contient 47 branches `if (name === "...")`. Elle est définie dans `continueRun` parce qu'elle lit et écrit des closures de run :

| Closure | Défini à | Rôle |
|---|---|---|
| `runSecrets` | `:1222` (alimenté `:1579`) | rédaction |
| `approvalRules`, `autoReview` | `:1671`, `:1681` | décision d'approbation |
| `computerInstruction`, `workspaceInstruction` | `:1701-1711` | prompt système |
| `flushPendingTools`, `recordToolOutput` | `:1755`, `:1768` | persistance des blocs outil |
| `progressRedactor`, `flushProgress`, `publishMidTurnNarration` | `:1780`, `:1783`, `:1807` | streaming vers l'utilisateur |
| `pauseForApproval`, `pauseForSecret`, `nextMutatingEffectOccurrence` | `:1841`, `:1846`, `:1853` | arrêt du run en attente |

Et à l'intérieur de `applyTool`, des sous-closures qui sont l'orchestration elle-même : gardes de tête `:1866-1874`, décision d'approbation `:2050-2075`, `runAutoReview` `:2127`, `bypassApproval` `:2232`, `claimOrReturn` `:2235`, `requestApproval` `:2256` (renouvelle le lease avant de mettre en pause), `persistEffectResult` `:2358`, `finish` `:2367`.

## Dispatch et orchestration

Les 47 branches ne sont pas homogènes. Deux familles :

**Dispatch pur** — la branche lit `args`, appelle une dépendance (`deps.sandbox`, `deps.repo`, `deps.memory`…), rend un résultat via `finish(...)`. Exemples : `list_files` `:2406`, `read_file` `:2421-2459`, `write_file` `:2460`, `open_path` `:2639`, `scratchpad_*` `:2748-2787`, `schedule_*` `:2796-2825`, `skill_*` `:2836-2889`, `recall_memory` `:3008`, `save_memory` `:3022`, `forget_memory` `:3035`, `list_secrets` `:3056`, `web_search` `:2712`, `web_fetch` `:2715`. Elles ont besoin de `bot`, `computer`, `computerMode`, `runSecrets` (pour rédiger), et de `deps`. Rien d'autre.

**Orchestration** — la branche change l'état du run ou du thread, ou parle à d'autres bots : `request_secret` `:3084` (met le run en `waiting_input`), `request_takeover` `:3301`, `run_subagent` `:3302` (le vrai travail est dans `pi-runtime.ts:1155`, la branche rend `{ ok: true, result: args.task }`), `spawn_bot` `:3323`, `update_bot` `:3375`, `message_user` `:3450`, `message_bot` `:3487`, `connect_agent` `:3509`, `handoff_to_bot` `:3543`, `delete_bot` `:3553`, `shell` `:2604` (garde desktop `:2606-2611`, enveloppe `BACKGROUND_WORK_LAUNCH` `:2618-2635`, `redactAgentCommandResult` `:2637`), `computer_act` `:2380`, `add_mcp_server` `:2905`.

Le registre ne concerne que la première famille. La seconde reste dans la closure jusqu'à ce qu'un besoin (03, 07) la fasse bouger.

## Ce que grok fait

`agent-exec/` a 60 fichiers, un par outil ou par préoccupation transverse (`pi-edit.ts`, `pi-grep.ts`, `background-shell.ts`, `mcp-allowlist-precheck.ts`…). Ce sont des déclarations de ressources RPC (`createResource<Executor<Args, Result>, RemoteExecManager, ControlledExecManager>(...)`), pas des implémentations : le dispatch est fait par le protocole, chaque outil est un endpoint typé par un message protobuf (`proto/generated/agent/v1/pi_edit_exec_pb.ts` : `path`, `edits`, résultat `oneof success | error | rejected`). Ce qu'on en retient : un outil = un nom + un schéma d'entrée + un schéma de sortie + une fonction, et le résultat distingue erreur d'exécution et refus de permission. Le transport RPC ne s'applique pas.

## Forme du registre

```ts
type ToolContext = {
  bot; computer; computerMode; runSecrets: string[];
  deps: Pick<ExecutorDeps, "sandbox" | "repo" | "memory" | …>;
};
type ToolHandler = (args: unknown, ctx: ToolContext) => Promise<unknown>;
const TOOL_HANDLERS: Record<string, ToolHandler> = { list_files, read_file, write_file, … };
```

Dans `applyTool`, après les gardes de tête et la décision d'approbation, avant les 47 `if` :

```ts
const handler = TOOL_HANDLERS[name];
if (handler) return finish(await handler(args, toolContext));
```

`finish`, `persistEffectResult`, `claimOrReturn`, `requestApproval` ne bougent pas : le registre rend une valeur, la closure décide ce qu'elle en fait. Les branches déplacées sont supprimées du `if` en cascade. Pas de classe, pas d'interface `Tool` avec une implémentation : un objet de fonctions dans un fichier `tool-handlers.ts` suffit tant qu'aucun besoin ne demande plus (03 pourrait en demander).

## Ordre de découpe

1. Sortir `ToolContext` et les handlers de la famille « dispatch pur » listés ci-dessus vers `packages/adapters/src/tool-handlers.ts`. Le fichier ne dépend pas de `continueRun`. Environ 25 branches, ~600 lignes déplacées.
2. Écrire le test unitaire des handlers sur `fake-sandbox` sans passer par `createRunExecutor`. C'est le gain immédiat : aujourd'hui tester `read_file` demande de monter un run complet.
3. Ne pas toucher aux tests existants : 11 fichiers `executor*.test.ts`, 4 134 lignes, tous passent par `createRunExecutor` et doivent rester verts sans modification. C'est le critère de non-régression.
4. Ensuite seulement, si 03 conclut à un pipeline interne, ajouter `before`/`after` autour de l'appel du handler.

Ce qui n'est pas dans ce ticket : sortir `continueRun` de `createRunExecutor`, découper la boucle de tour, toucher à `buildSystemInstructions` (05) ou à `runSandboxCommand` (02, 07).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `ToolContext` défini avec le strict nécessaire des handlers de dispatch pur ; pas de closure de run dedans
- [ ] `tool-handlers.ts` : handlers extraits pour `list_files`, `read_file`, `write_file`, `open_path`, `scratchpad_*`, `schedule_*`, `skill_*`, `recall_memory`, `save_memory`, `forget_memory`, `list_secrets`, `web_search`, `web_fetch` — même comportement, mêmes messages d'erreur
- [ ] `applyTool` appelle le registre après la décision d'approbation, `finish` reste dans la closure
- [ ] Les branches déplacées sont supprimées de la cascade `if (name === …)` ; les branches d'orchestration restent
- [ ] Tests unitaires des handlers sur `fake-sandbox` sans `createRunExecutor`
- [ ] Les 11 `executor*.test.ts` passent sans modification
- [ ] `edit_file` (01) est écrit directement comme handler du registre si 01 passe après ce ticket
