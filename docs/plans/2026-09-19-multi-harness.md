# Multi-harness — Claude Code à côté de Pi, porte ouverte aux suivants — Exploration & Plan

> **For Claude:** ce document est le résultat de l'exploration du code et le contrat d'implémentation. Les décisions de la section « Decisions already made » ne se rouvrent pas dans une PR. Toute question d'écart remonte au mainteneur.

**Goal :** un bot Rakazo peut tourner sur **Pi** (aujourd'hui) ou sur **Claude Code** (v1 de ce plan). Claude Code tourne **dans le computer du bot**, garde **ses outils natifs** (Bash, Read, Edit, Grep, subagents, skills…) et son état de l'art, et reçoit en plus, via **un seul serveur MCP généré**, les outils Rakazo qu'il ne peut pas avoir : **parler à l'UI, agir sur le computer, parler aux autres bots**. Mémoire, skills, planification : ceux du harness. Les serveurs MCP du bot sont injectés dans sa config, pas proxifiés. L'utilisateur s'authentifie avec **le login natif du CLI**, Rakazo ne voit ni ne stocke aucun token. Le point d'extension pour Codex, OpenCode, Grok Build est un objet `HarnessProfile` ; les faits déjà vérifiés sur ces trois-là sont en annexe, pas dans le scope v1.

---

## 1. Ce que l'exploration a établi

### 1.1 La couture existe déjà : `AgentRuntime`

`packages/adapter-kit/src/interfaces.ts:229`

```ts
export interface AgentRuntime {
  describe(): AdapterDescriptor<AgentRuntimeCapabilities>;
  run(request: AgentRunRequest, context?: Partial<AdapterContext>): AsyncIterable<AgentRuntimeEvent>;
  abort(runId: string): Promise<void>;
}
```

- `AgentRunRequest` (`types.ts`) porte `prompt`, `instructions`, `history`, `tools: ConnectorTool[]`, `model`, `executeTool(name, args, executionId, route?)`, `resumeFromCheckpoint?`, `claimSteering?`.
- `AgentRuntimeEvent` = `text | progress | tool | ask | takeover | usage | checkpoint{blob} | subagent | done`.
- Deux implémentations : `PiAgentRuntime` (`packages/adapters/src/pi-runtime.ts:167`) et `ScriptedAgentRuntime` (`scripted-runtime.ts`, ~150 lignes, modèle de « seconde implémentation minimale »).
- Sélection **process-wide** par env : `apps/worker/src/index.ts:80-84`, `apps/api/src/app.ts:305`, `AGENT_RUNTIME=pi|scripted`.
- **Manque au contrat** : le runtime ne reçoit pas le sandbox. `run()` devra recevoir `sandbox` + `computer` (nouveau champ optionnel de `AgentRunRequest`). Pi l'ignore.

### 1.2 Pi n'est pas un CLI, Claude Code l'est

Pi = librairie dans le process worker, aucun accès filesystem, outils exécutés par l'hôte via `executeTool` (`pi-runtime.ts:940-1010`). Le `shell` Rakazo tourne déjà dans le computer via `sandbox.execute` (`executor.ts:2528`, `runSandboxCommand`).

Claude Code = sous-processus avec ses propres outils (Bash/Read/Edit/Grep, subagents, skills, plan mode), son session store, sa config. **Si on lui coupe ses outils natifs pour passer par les outils Rakazo, on perd l'état de l'art du harness.** Donc il tourne **là où vit le workspace** : dans le computer du bot. Son Bash et le `shell` Rakazo frappent le même filesystem, le même OS user, la même boîte.

### 1.3 Le modèle d'outils est déjà MCP-compatible

- `ConnectorTool { name, description, inputSchema, readOnly?, route? }` = un tool MCP.
- Serveurs MCP des bots (`add_mcp_server`, `mcp-connector.ts:69-140`) : URL + auth déjà stockées côté Rakazo. Pour un harness, `writeConfig` les écrit dans sa config MCP : le harness s'y connecte en direct, pas de proxy. C'est l'injection centrale demandée.
- Approvals, effect replay, lazy catalog : `applyTool` (`executor.ts:1784`), côté hôte. S'appliquent aux outils que Rakazo expose au harness (§2.2).
- `@modelcontextprotocol/sdk@1.30.0` déjà dépendance de `packages/adapters`.

### 1.4 Le computer : ce qu'il a et ce qu'il n'a pas

`infra/sandboxes/computer/Dockerfile` (debian bookworm-slim) : Xvfb, x11vnc, fluxbox, **xterm**, xdotool, noVNC, python3, curl, jq, **Chromium**. Pas de Node, pas de git.

`infra/sandboxes/supervisor/src/index.ts` : un **réseau Docker par bot** (`ensureBotNetwork`, ou `internal` si `SANDBOX_SCREEN_NETWORK=internal`), un **volume HOME persistant** (`storage.homeVolume`), binds skills. Le worker parle au computer via le supervisor (`SANDBOX_SUPERVISOR_URL`, `/computers/<id>/exec`). **Le computer ne peut pas joindre le worker** : pas sur le même réseau, worker non publié. E2B/Daytona/Box : le computer est distant, le worker n'est joignable qu'à travers l'API publique (tunnel Cloudflare).

`CommandRequest { argv, cwd, env, pty?, timeoutMs? }` → `ProcessEvent stdout|stderr|exit`. **Pas de stdin.** `sandbox.writeFile` / `readFile` existent.

`docs/computer-runtime.md` : « The computer container is the security boundary. Team bots share the OS user, workspace, browser profiles, and shell/X11 access. » Un harness avec Bash natif dans le computer ne change pas ce périmètre.

### 1.5 Auth et modèle : ne pas réutiliser le modèle Pi

`resolveModelKey` / `pi-oauth.ts` déchiffrent un secret Rakazo et rejouent les logins des éditeurs (client id Claude Code dans `pi-anthropic-oauth.ts`). **Hors sujet pour un harness** : un vrai Claude Code se connecte avec `claude` → `/login`. Il écrit ses credentials dans son HOME (persistant dans le computer), Rakazo n'y touche pas.

---

## 2. Architecture cible

```
worker                                          computer du bot (sandbox)
──────                                          ─────────────────────────
executor ─run()─▶ HarnessRuntime(profile)
   │  1. authStatus via sandbox.execute ──────▶ claude auth status
   │  2. writeFile : tools.json, instructions.md, .mcp.json (rakazo + serveurs MCP du bot)
   │  3. execute wrapper ─────────────────────▶ rakazo-harness-run <runId> claude -p … --mcp-config … --append-system-prompt-file …
   │                                              ├─ CLI (stream-json → out.jsonl)      ← outils natifs : Bash, Edit…
   │                                              ├─ rakazo-mcp (stdio, lancé par le CLI)
   │                                              │     tools/call → écrit req dans mailbox/<runId>/req.jsonl
   │                                              │     attend mailbox/<runId>/res/<id>.json
   │                                              └─ tail -F out.jsonl req.jsonl → stdout (multiplexé)
   │  4. parse stdout : lignes CLI → AgentRuntimeEvent ; lignes req → executeTool()
   │  5. writeFile mailbox/<runId>/res/<id>.json ─▶ (rakazo-mcp répond au CLI)
   │  6. exit → checkpoint { sessionId }
```

**Un runtime générique, un profil par harness.** Tout ce qui est spécifique à Claude Code vit dans un objet `HarnessProfile` sans état ; `HarnessRuntime`, `rakazo-mcp`, la mailbox, le wrapper, l'auth status, la sélection par bot sont génériques. Ajouter Codex plus tard = un fichier `profiles/codex.ts` + le binaire dans l'image + une entrée dans le registre. Rien d'autre.

```ts
interface HarnessProfile {
  id: string;                                   // "claude-code"
  bin: string;
  argv(input: { prompt: string; resumeId?: string; modelId?: string; mcpConfigPath: string; instructionsPath: string }): string[];
  /** Fichiers à écrire avant le run : config MCP (rakazo-mcp + serveurs du bot), permissions. Jamais l'auth. */
  writeConfig(input: { cwd: string; mcpShimPath: string; botMcpServers: McpServerConfig[] }): Array<{ path: string; content: string }>;
  authStatusArgv(): string[];
  parseAuthStatus(stdout: string): { signedIn: boolean; account?: string };
  loginHint: string;                            // « ouvrez le terminal du bot et lancez `claude` »
  parse(line: string): AgentRuntimeEvent[] | { sessionId: string } | null;
}

export const HARNESS_PROFILES: Record<string, HarnessProfile> = { "claude-code": claudeCodeProfile };
```

Une seule implémentation en v1 : l'interface existe parce que le mainteneur veut la porte ouverte, pas par spéculation. Pas de registre dynamique, pas de plugin loader : un `Record` et un import.

### 2.1 Le pont MCP : un serveur stdio dans le computer, une mailbox vers le worker

Pas de réseau computer → worker, pas de stdin : le canal de retour passe par **le stdout déjà streamé** et **`writeFile`**.

- `rakazo-mcp` (script Node ~120 lignes, installé dans l'image computer) : serveur MCP stdio lancé par le CLI. `tools/list` = le fichier `mailbox/<runId>/tools.json` écrit par le worker avant le run (= `RAKAZO_BRIDGE_TOOLS ∩ request.tools`, liste fermée §2.2). `tools/call` → append `{id, name, args}` dans `req.jsonl`, puis attend `res/<id>.json` (poll 50 ms local, pas d'appel réseau).
- `rakazo-harness-run` (bash ~30 lignes) : lance le CLI avec stdout → `out.jsonl`, et `tail -F out.jsonl req.jsonl` vers son stdout. Un seul writer par fichier, `tail` préfixe chaque bascule d'un header `==> fichier <==` : le worker sait de quel flux vient chaque ligne. Pas d'interleaving mi-ligne.
- Côté worker, `HarnessRuntime` lit le stream `execute` : ligne `out.jsonl` → `profile.parse` ; ligne `req.jsonl` → `request.executeTool(name, args, id, route)` → `sandbox.writeFile(res/<id>.json)`. Approvals et effects : inchangés, c'est l'executor.
- **Outils spéciaux** (même sémantique que `pi-runtime.ts:940-1010`) : `ask_user` / `request_secret` → événement `ask`, réponse `{paused: true}` au CLI, puis `abort` du process ; reprise au tour suivant avec `--resume`.
- Latence par appel d'outil ≈ un `writeFile` provider (Docker : ms ; E2B/Box : 100-500 ms). Acceptable : les outils chauds (fichiers, shell) sont natifs, ne passent pas par là.

Alternative écartée : serveur MCP HTTP dans le worker. Il faudrait attacher le worker au réseau de chaque bot (Docker) et un relais API ↔ worker pour les providers distants. La mailbox marche partout avec les primitives existantes.

### 2.2 Outils : le pont Rakazo n'expose que UI, computer, autres bots

Liste fermée `RAKAZO_BRIDGE_TOOLS` (constante dans `harness/runtime.ts`, commune à tous les profils) :

| Famille | Outils exposés au harness |
|---|---|
| UI | `message_user`, `ask_user`, `request_secret`, `attach_file`, `render_plot`, `request_takeover` |
| Computer | `computer_observe`, `computer_act`, `browser_navigate`, `browser_snapshot`, `open_path`, `launch_app` |
| Autres bots | `message_bot`, `handoff_to_bot`, `spawn_bot`, `update_bot`, `archive_bot`, `delete_bot`, `connect_agent`, `message_agent`, `respond_agent_connection` |

Tout le reste vient du harness, pas de Rakazo :

| Rakazo (Pi) | Claude Code |
|---|---|
| `shell`, `read_file`, `write_file`, `edit_file`, `list_files` | Bash, Read, Write, Edit, Glob, Grep natifs |
| `remember`, `recall_memory`, `save_memory`, `forget_memory`, `scratchpad_*` | `CLAUDE.md`, memory dir, TodoWrite natifs |
| `skill_*` | `.claude/skills` |
| `web_fetch`, `web_search` | WebFetch / WebSearch natifs |
| `run_subagent` | subagents natifs |
| `schedule_*` | hors périmètre v1 ; le bot reste planifiable depuis l'UI Rakazo, pas depuis le harness |
| `add_mcp_server`, `mcp__<slug>__*` | injectés dans `.mcp.json` généré, connexion directe |
| `list_secrets`, `forget_secret`, connecteurs Rakazo | non exposés v1 |

Conséquences assumées :

- Les gardes Rakazo sur `shell` (`isProtectedComputerLifecycleCommand`, teaching guard, approbations) ne s'appliquent pas au Bash natif. Le périmètre de sécurité reste le container (doc existante). Les instructions injectées ajoutent la consigne « ne pas arrêter les processus desktop/browser » ; c'est de la politesse, pas une garde.
- Permissions : `--permission-mode bypassPermissions`, aucun prompt interactif. Les approbations Rakazo continuent de s'appliquer aux outils Rakazo (elles vivent dans `applyTool`).
- `workspaceCheckpoint.markDirty()` à chaque run harness : on ne sait pas ce que Bash a touché.
- La mémoire Rakazo (`remember`) et la mémoire du harness ne se voient pas.
- **`instructions` du bot injectées au runtime, en append, pas écrites dans le workspace.** `--append-system-prompt-file mailbox/<runId>/instructions.md`. Le system prompt natif reste (c'est lui l'état de l'art) ; le `CLAUDE.md` du projet du bot, s'il y en a, continue de marcher. `--system-prompt-file` (replace) existe, non utilisé.

Ligne de commande v1 :

```
claude -p <prompt> --output-format stream-json --verbose --include-partial-messages \
  --permission-mode bypassPermissions --mcp-config <cwd>/.rakazo/mcp.json --strict-mcp-config \
  --append-system-prompt-file <mailbox>/instructions.md [--model <id>] [--resume <session_id>]
```

Flags validés contre la version pinnée dans l'image au moment de la PR.

### 2.3 Authentification : login natif, dans le desktop du bot

Le HOME du computer est persistant (volume Docker `homeVolume` ; workspace persistant chez E2B/Daytona/Box). Claude Code y écrit ses credentials (`~/.claude/`). Rakazo ne lit, ne parse, ne copie jamais ces fichiers.

**Login = l'utilisateur ouvre le desktop du bot (« Take control »), lance `xterm`, tape `claude`, suit `/login`.** Le CLI ouvre son URL dans le Chromium du même desktop, l'utilisateur se connecte, le CLI stocke sa session. Flow de l'éditeur à 100 %, provider-agnostic (Docker, E2B, Daytona, Box), zéro code Rakazo. Abonnement Pro/Max ou clé API : au choix, dans le flow du CLI.

**Statut** : `claude auth status` (à vérifier selon version), parsé par `profile.parseAuthStatus`.

**UI** : au choix d'un runtime dans le bot-panel, l'API exécute `authStatusArgv` dans le computer et affiche « Claude Code : connecté (compte …) » ou « non connecté : ouvrez le terminal du bot et lancez `claude` » (`loginHint`). Un run sur un harness non connecté échoue immédiatement avec ce message.

**Modèle du bot** : pour un runtime harness, `modelProvider`/`modelId` Rakazo ne portent plus de credential. `modelId` seul est passé au CLI si renseigné, sinon défaut du harness. `resolveModelKey` court-circuité quand `capabilities.hostCredentials === false` (nouveau flag, `true` pour Pi). Le picker modèle devient un champ texte libre `modelId` pour un runtime harness.

**Portée** : une session harness par computer (donc par bot, ou par équipe de bots partageant un computer). C'est le grain naturel du HOME. Pas de notion de compte harness côté Rakazo.

### 2.4 Événements (stream-json → `AgentRuntimeEvent`)

| stream-json | → |
|---|---|
| `system.init` | `{ sessionId }` |
| `assistant` avec `content[].type === "text"` (partiels via `--include-partial-messages`) | `text` |
| `assistant` avec `tool_use` (natif ou `mcp__rakazo__*`) | `tool` |
| `result` | `usage` + `checkpoint{ harness, sessionId }` + `done` |

Les appels d'outils natifs (Bash, Edit…) remontent comme `tool` events : l'UI Rakazo les affiche comme aujourd'hui. `progress` = thinking si exposé. `subagent` : non émis v1.

### 2.5 Historique et checkpoint

- Premier tour d'un thread : `request.history` injecté dans le prompt (préfixe « Conversation so far »). Tours suivants : `--resume` porte l'historique côté harness, `history` ignoré.
- `checkpoint.blob` = `{ harness, sessionId }`. Les sessions vivent dans `~/.claude/` du computer, persistant. Compaction = celle du harness.
- Le workspace checkpoint Rakazo (export/import) inclut-il le HOME ? À vérifier : si non, les sessions harness sont perdues au restore, le run repart sans `--resume` (dégradé, pas cassé).

### 2.6 Sélection par bot

- Prisma : `Bot.runtime String?` (null = défaut process `AGENT_RUNTIME`).
- Contracts (`packages/contracts/src/domain.ts:74`, `:338`) : `runtime` à côté de `modelProvider`.
- Composition roots : `runtimes: Record<string, AgentRuntime>` = `{ pi, scripted, ...Object.fromEntries(Object.entries(HARNESS_PROFILES).map(([id, p]) => [id, new HarnessRuntime(p)])) }`. L'executor résout `runtimes[bot.runtime ?? default]` et passe `sandbox` + `computer` dans la requête. Un runtime harness exige un computer (`computerMode !== "none"`), sinon erreur claire.
- Web : `NativeSelect` dans `apps/web/src/pages/shell/bot-panel.tsx` (à côté du picker modèle, `:518`), options = clés de `runtimes` exposées par l'API, avec le statut d'auth.

### 2.7 Image computer

`infra/sandboxes/computer/Dockerfile` : + Node 22 (tarball officiel, pas de `apt nodejs`), + `git`, + `npm i -g @anthropic-ai/claude-code@<pin>`, + `rakazo-mcp` et `rakazo-harness-run` dans `/usr/local/bin`. Les templates E2B/Daytona/Box construits depuis ce Dockerfile suivent. Taille image : +~250 Mo, à mesurer.

---

## 3. Decisions already made (ne pas rouvrir)

1. **Scope v1 = Pi + Claude Code.** Codex, OpenCode, Grok Build : un `HarnessProfile` chacun, plus tard, sur demande. L'annexe garde ce qui est déjà vérifié.
2. **Couture = `AgentRuntime`.** Pas de nouveau contrat ; un champ optionnel `sandbox`/`computer` dans la requête, ignoré par Pi.
3. **Un `HarnessRuntime` générique + profils objets sans état, registre = `Record` statique.** Pas de classe par harness, pas de plugin loader.
4. **Le harness tourne dans le computer du bot et garde ses outils natifs.** Rakazo n'est pas « les mains » : il fournit ce que le harness ne peut pas avoir : UI, computer, autres bots. Liste fermée `RAKAZO_BRIDGE_TOOLS`. Mémoire, skills, web, subagents, planification = harness ou hors périmètre.
5. **Un serveur MCP Rakazo stdio par run, dans le computer, relié au worker par mailbox sur le stream `execute` + `writeFile`.** Pas de réseau computer → worker, pas de relais API.
6. **Les serveurs MCP du bot sont écrits dans la config du harness, pas proxifiés.** Rakazo reste le point unique de config, le harness parle en direct.
7. **`instructions` injectées au runtime en append** (`--append-system-prompt-file`), jamais écrites dans le workspace, jamais en replace.
8. **Auth = login natif du CLI, fait par l'humain dans le desktop du bot.** Rakazo ne stocke, ne lit, ne génère aucun token pour un harness. Les flows OAuth de `pi-oauth.ts` restent réservés à Pi.
9. **Permissions harness en mode non-interactif total.** Le container est le périmètre de sécurité (doc existante). Les approbations Rakazo ne couvrent que les outils Rakazo.
10. **Pause = kill + resume.** Pas de process CLI maintenu vivant en attente d'une réponse.
11. **Pi reste le défaut.** `CONTRIBUTING.md` (« product path is Pi + Docker + Graphile ») ne change pas. Un runtime harness sans computer = erreur, pas de fallback silencieux vers Pi.

---

## 4. PRs

### PR 0 — Image computer
- Node 22, git, `@anthropic-ai/claude-code` pinné, `rakazo-mcp`, `rakazo-harness-run`. Test : `rakazo-mcp` seul (client MCP SDK ↔ mailbox sur tmpdir). Aucun changement de comportement produit.

### PR 1 — `HarnessRuntime` + profil Claude Code
- `packages/adapters/src/harness/{runtime.ts, mailbox.ts, profile.ts, profiles/claude-code.ts}`, `RAKAZO_BRIDGE_TOOLS`, `HARNESS_PROFILES`, injection des serveurs MCP du bot et des instructions, champ `sandbox`/`computer` dans `AgentRunRequest`, `capabilities.hostCredentials`, court-circuit `resolveModelKey`.
- Sélection env only : `AGENT_RUNTIME=claude-code`.
- Tests : `FakeSandbox` existant + faux binaire (`packages/testkit`) qui rejoue un stream-json et écrit dans la mailbox. Pas de vrai Claude Code en CI.
- `CHANGELOG.md` : « Run a bot on Claude Code inside its computer ». Doc `docs/harnesses.md` (installation, login dans le desktop, ce que Rakazo ne fait pas, comment ajouter un profil).

### PR 2 — Sélection par bot
- Migration `Bot.runtime`, contracts, `bot-update.ts`, `bot-panel.tsx`, endpoint runtimes disponibles + `authStatus` par computer. Picker modèle → `modelId` libre pour un harness.

### PR 3 — Docs
- `docs/computer-runtime.md` : paragraphe « harness externes tournent dans le computer, à côté du shell Rakazo ». `.env.example` : valeurs de `AGENT_RUNTIME`.

---

## 5. Risques et points ouverts

- **Mailbox = mécanisme maison.** ~150 lignes au total, mais c'est un IPC par fichiers. Si un jour le contrat sandbox gagne un stdin ou un canal bidirectionnel, le remplacer. Marqué `ponytail:` dans le code.
- **Bash natif sans gardes Rakazo.** Le harness peut tuer Xvfb/Chromium ou sortir du workspace du bot (même OS user pour toute l'équipe). Aujourd'hui `shell` a `isProtectedComputerLifecycleCommand`. Accepté : périmètre = container. Documenter dans `docs/harnesses.md`.
- **Serveurs MCP du bot avec auth.** Header/token écrits en clair dans `.rakazo/mcp.json` du workspace (même OS user pour l'équipe). Aujourd'hui le proxy Rakazo les gardait côté worker. Accepté : périmètre = container ; fichier en mode 600 ; documenter.
- **Mémoire scindée.** Ce que le bot apprend sous Pi (`remember`) n'est pas visible sous Claude Code et inversement. Pas de sync v1.
- **Login headless impossible sans desktop.** Un bot en `computerMode` sans écran (ou `SANDBOX_PROVIDER=none`) ne peut pas se connecter. Fallback : `sandbox.execute` de la commande de login avec `pty: true` et affichage du stdout (URL + code) dans l'UI — c'est encore le flow de l'éditeur, juste relayé. Hors v1.
- **Expiration de session.** Gérée par le CLI. `authStatus` la signale, le run échoue proprement. Pas de relogin automatique.
- **Sessions harness et checkpoint workspace.** Si le HOME n'est pas dans l'export/import, `--resume` échoue après restore ; repartir sans resume.
- **Latence.** Spawn CLI par tour ≈ 1-3 s. Mesurer en PR 1.
- **Coût/quota.** System prompt Claude Code par-dessus `instructions`. Consommé sur l'abonnement de l'utilisateur : le dire dans l'UI (ton de `SUBSCRIPTION_SIGN_IN_PROVIDERS.billing`).
- **Steering** (`claimSteering`) : ignoré pour les runtimes harness en v1, doc explicite.
- **Image computer +250 Mo.** Option : image `rakazo/computer-harness` séparée si ça gêne les déploiements Pi-only. Décider en PR 0 sur mesure réelle.

---

## Annexe — prochains profils (hors scope, faits vérifiés le 2026-09-19)

Chaque ligne = un futur `profiles/<id>.ts` + le binaire dans l'image. Le reste (runtime, mailbox, bridge tools, sélection, auth UI) est déjà générique.

| | Codex | OpenCode | Grok Build (xAI, beta SuperGrok / Premium Plus) |
|---|---|---|---|
| Non-interactif + stream | `exec --json -c approval_policy=never -c sandbox_mode=danger-full-access` | `run --format json --auto` | `-p --output-format streaming-json --always-approve` |
| MCP | `.codex/config.toml` généré (`mcp_servers.rakazo` + serveurs du bot) | `opencode.json` généré (`mcp.rakazo` local + serveurs du bot remote) | `.grok/config.toml` (format à vérifier) |
| Instructions (append) | `-c developer_instructions="…"` | `instructions: [<path>]` dans `opencode.json` | `--rules <TEXT>` (alias `--append-system-prompt`) |
| Instructions (replace, non utilisé) | `-c model_instructions_file=<path>` | agent custom `prompt: "{file:…}"` + `run --agent` | `--system-prompt-override <TEXT>` |
| Modèle | `-m` | `--model provider/id` | `-m` |
| Reprise | `codex exec resume <thread_id>` | `--session <id>` | `--resume <id>` (sessions dans `~/.grok/sessions`) |
| Login natif | `codex login` / `codex login --device-auth` | `opencode auth login` | `grok login` / `grok login --device-auth` |
| Statut auth | `codex login status` | `opencode auth list` | à vérifier (`grok inspect` ?) |
| Événements | `thread.started` → sessionId ; `item.completed agent_message` → text ; `command_execution` / `mcp_tool_call` → tool ; `turn.completed.usage` | `text` / `tool` / `step_finish` | à vérifier |

Grok = **Grok Build** (`curl -fsSL https://x.ai/cli/install.sh | bash`), pas `superagent-ai/grok-cli`.
