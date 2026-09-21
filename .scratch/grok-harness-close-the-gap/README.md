# Combler l'écart avec le harness grok bot 0.18

Issu d'une comparaison entre le harness d'agent de rakazo (`packages/adapters/src/executor.ts`, `pi-runtime.ts`, `builtin-tools.ts`, `history-compaction.ts`, `lazy-tool-catalog.ts`, `pi-runtime-limits.ts`, `tool-loop.ts`) et l'architecture reconstruite de grok bot 0.18 ([b-nnett/grok-bot-0.18-reconstructed](https://github.com/b-nnett/grok-bot-0.18-reconstructed), packages `agent`, `agent-core`, `agent-exec`, `agent-summarization`, `agent-transcript`, `hooks`, `hooks-exec`, `prompt-jsx`, `redaction`, `agent-kv`, `shell-exec`, `mcp-core`). Chaque ticket est ancré sur un comportement constaté dans le code de rakazo, avec `fichier:ligne` vérifié à la main ; grok sert de référence de conception, pas de modèle à copier. Là où la reconstruction grok est vide (modules réduits à `export {}` par le tree-shaking), le ticket le dit et ne s'appuie pas dessus.

## Ce que pi-agent-core fournit déjà

Découverte transverse, reprise dans 01, 02, 03, 08 et 10. `@earendil-works/pi-agent-core@0.85.1` est déjà dépendance directe de `packages/adapters`. Rakazo n'en utilise que la classe `Agent` (`pi-runtime.ts:338` et `:1213`). Le reste se range en quatre étages, et seuls les deux premiers sont exploitables sans chantier :

| Étage | Ce que c'est | Coût d'adoption |
|---|---|---|
| **Déjà sur l'objet que rakazo construit, inutilisé** | `AgentOptions.beforeToolCall` (`dist/agent.d.ts:13`), `afterToolCall` (`:14`), `shouldStopAfterTurn` (`:15`) — un handler unique chacun, exécutés par la boucle pi autour de chaque outil et à chaque fin de tour. Rakazo ne renseigne que `transformContext` (`pi-runtime.ts:344`, `:1222`) et `prepareNextTurnWithContext` (`:346`) | une propriété de plus dans le `new Agent({…})` existant |
| **Fonctions pures réexportées par la racine** | `truncateHead` / `truncateTail` / `truncateLine`, `DEFAULT_MAX_LINES = 2000`, `DEFAULT_MAX_BYTES` = 50 Ko, `TruncationResult` (`dist/index.d.ts:23` → `harness/utils/truncate.ts`). Aucune occurrence dans `packages/` | un import |
| **Exporté mais non branchable en l'état** | `createBashTool` / `createEditTool` / `createReadTool` / `createWriteTool` (`dist/index.d.ts:19`) exigent un `ExecutionToolContext` dont `env: ExecutionEnv extends FileSystem, Shell` — une quinzaine de méthodes que rakazo n'a pas côté sandbox. Le débordement sur fichier (`spillPath`, `harness/types.d.ts:238` ; `fullOutputPath`, `tools/bash.d.ts`) est **possédé par l'`ExecutionEnv`**, pas par `truncate.ts` : il ne se réutilise pas, il se réécrit (02) | implémenter un `FileSystem` sur `SandboxProvider` — disproportionné |
| **Hors de portée** | La couche `AgentHarness` et son registre multi-handlers (`harness.hooks: Hooks`, `agent-harness.d.ts:702`, 11 étapes : `before_run`, `before_drive`, `before_run_end`, `transform_context`, `before_request`, `before_payload`, `after_response`, `before_tool`, `after_tool`, `before_compaction`, `before_navigation`). `AgentHarness.create(options, context)` exige une `Session` durable, des `Models` et des outils `ExecutionToolContext`. La classe `HookRegistry` elle-même n'est pas dans la carte `exports` du package | migrer de `Agent` vers `AgentHarness` — chantier à part entière, non cadré |

Conséquence : plusieurs écarts se comblent en câblant ce qui est déjà instancié, pas en réécrivant grok.

## Tickets

| # | Titre | Bloqué par | Statut |
|---|---|---|---|
| 01 | Ajouter un outil `edit_file` ; trancher `grep`/`glob` | — | ready-for-agent |
| 02 | Borner les résultats d'outils en tête+queue avec débordement sur fichier | — | ready-for-agent |
| 03 | Cadrage — une couche de hooks pour un bot hébergé multi-tenant | — | needs-scoping |
| 04 | Découper `executor.ts` et introduire un registre d'outils | — | ready-for-agent |
| 05 | Assembler le prompt système en blocs typés et ordonnés | — | ready-for-agent |
| 06 | Faire lire le scratchpad au résumeur de compaction | — | ready-for-agent |
| 07 | Exécuter une commande shell en arrière-plan sans bloquer le tour | — | ready-for-agent |
| 08 | Borner un run par pas, par tokens et par horloge | — | ready-for-agent |
| 09 | Décision — rendre les subagents durables ou assumer l'éphémère | — | needs-decision |
| 10 | Décision — une allowlist opérateur avant le dispatch | — | needs-decision |
| 11 | Rédacter l'enregistrement de session Pi JSONL | — | ready-for-agent |

## Ordre de lecture

01 et 02 sont indépendants de tout et se livrent en premier : ils touchent une branche de `applyTool` chacun, et 02 remplace une troncature de queue à 12 000 caractères par les utilitaires que pi-agent-core exporte déjà — l'import couvre la troncature, le débordement sur fichier reste à écrire (il appartient à l'`ExecutionEnv` de pi, voir la table ci-dessus). 04 est le ticket structurant : `applyTool` est une closure de 1 759 lignes (`executor.ts:1860-3618`) dans une méthode `continueRun` de 3 470 lignes (`:1121-4591`) ; le ticket cartographie ce qui est du dispatch pur et ce qui dépend des closures partagées, et propose un premier pas isolable qui ne casse aucun des 11 fichiers `executor*.test.ts` (4 134 lignes). 03 n'est pas prêt, mais pour une autre raison qu'annoncé au départ : ce n'est pas « porter les 21 étapes de hooks de grok », et ce n'est plus non plus « attendre que 04 fasse apparaître un point d'accroche » — l'accroche existe déjà (`beforeToolCall` / `afterToolCall` sur l'`Agent` instancié). Ce qui reste à trancher est la gouvernance : qui écrit une règle, par quel canal, et si le slot mono-handler de pi suffit. 10 s'installe derrière ce même `beforeToolCall`, avant ou sans 03 ; si 03 conclut à un pipeline, celui-ci se pose au même endroit et 10 en devient la première règle. 05 interagit avec le préfixe cacheable livré par `harness-context-quality` ticket 02 (`c88ba4b6`) et doit le préserver. 08 et 11 corrigent une prémisse de l'audit initial : il existe déjà un plafond par tour (`MAX_TOOL_CALLS_PER_TURN`) et l'export de traces est bien rédacté ; le trou réel est ailleurs et plus petit dans les deux cas. 08 s'accroche lui aussi sur un rappel déjà disponible (`shouldStopAfterTurn`) : comme 03 et 10, il n'attend pas 04. 04 reste le bon ticket pour la lisibilité de `applyTool`, mais il ne bloque plus personne — d'où la colonne « Bloqué par » vide partout.

## Ce qui n'est pas dans ce dossier

Ce que rakazo fait déjà bien, et qu'il ne faut pas rouvrir :

- **Catalogue d'outils paresseux.** `lazy-tool-catalog.ts` expose `search_tools` / `load_tool` / `execute_tool` par préfixe (`:52`, `:74`, `:91`) au-delà de `DIRECT_TOOL_LIMIT = 20` (`:9`). Grok n'a qu'un `mcp-disk-catalog.ts` de lecture de définitions sur disque (deux constantes et un parseur). Rakazo est en avance.
- **Compaction en job de fond.** `compactHistory` (`history-compaction.ts:509`) tourne dans un job graphile enfilé en fin de run (`executor.ts:4448-4460`), avance un curseur `seq` contigu par CAS, estime les tokens avec `estimateTokens` de pi, et apprend des faits durables depuis le ticket 21 de `harness-context-quality`. L'équivalent grok (`background-summarization.ts`) n'apporte rien de plus.
- **Élagage des captures d'écran.** `DEFAULT_COMPUTER_SCREENSHOTS_TO_KEEP = 2` (`pi-runtime.ts:138`).
- **Rédaction en streaming.** `createStreamingRedactor(runSecrets)` (`executor.ts:1780`), 36 sites `redactSecrets(` dans `executor.ts`, export de traces rédacté (`pi-runtime.ts:547`), audit d'outil réduit aux métadonnées (`executor.ts:614-655`).
- **Suppression du contexte injecté avant compaction.** Grok a `context-stripping.ts` (23 tags à retirer du transcript). Rakazo n'en a pas besoin : la compaction lit les lignes de messages persistées (`history-compaction.ts:553`, `:586`) et le contexte injecté à l'exécution (mémoire rappelée, résumé compacté, scratchpad) n'est jamais persisté.

Ce qui a été écarté parce que grok est un IDE desktop Electron mono-utilisateur et rakazo un service hébergé multi-tenant : exécution locale des outils (`agent-exec/*` sont des déclarations de ressources RPC protobuf vers le shell Electron, pas des implémentations), hooks shell écrits par l'utilisateur final (`hooks/claude-code-mapper.ts` convertit une config Claude Code en config Cursor), `cursor-plugins`, `electron-*`, `context-processing-*` (36 fichiers de collecte de contexte IDE : sélection, terminal, PR, vidéo), `prompt-jsx` (rendu JSX de prompts ; le problème de rakazo est l'ordre et le typage des blocs, pas le moteur de rendu), `agent-kv` (blob store avec miroir cloud pour un client desktop), `goal-continuation.ts` (compteur d'horloge d'objectif lié à la session IDE).
