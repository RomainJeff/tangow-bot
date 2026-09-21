# 02: Borner les résultats d'outils en tête+queue avec débordement sur fichier

**What to build:** Un résultat d'outil trop long garde son début et sa fin, indique combien de lignes ont été omises, et la sortie complète est écrite dans un fichier de la sandbox que le modèle peut relire par morceaux. Aujourd'hui il est coupé net à 12 000 caractères : le début est gardé, la fin — donc le verdict d'une commande — est perdue.

## Comportement actuel

`packages/adapters/src/pi-runtime-limits.ts` :

| Constante / fonction | Valeur / comportement | Ligne |
|---|---|---|
| `TOOL_RESULT_TEXT_LIMIT` | `12_000` caractères | `:8` |
| `clipToolResultText` | `text.slice(0, limit - 1) + "…"` — la queue disparaît | `:10-12` |
| `clipToolResultContent` | un seul budget partagé entre toutes les parties texte d'un résultat | `:18-46` |

Appliqué à tout résultat d'outil dans `pi-runtime.ts` (`summarizeToolResult` `:1631-1638`, `boundAgentToolResult` `:1640-1646`) et au résultat d'un subagent (`clipToolResultText(result, 12_000)`, `:1331`).

Le cas qui fait mal est `shell`. `runSandboxCommand` (`executor.ts:5348-5382`) itère `sandbox.execute` et concatène tout `stdout` et `stderr` en mémoire (`stdout += event.data`, `:5373-5374`) sans plafond, jusqu'à `sandboxCommandTimeoutMs()` (5 min par défaut, 60 min max, `packages/core/src/sandbox-command.ts:1-9`). Puis la branche `shell` (`:2637`) rend le résultat, et le clip garde les 12 000 premiers caractères. Pour un `npm test` ou un `pytest` qui échoue, le verdict est à la fin : le modèle voit le début de la sortie, pas l'erreur. Pour un `tail -f` mal borné, le processus remplit la mémoire du worker jusqu'au timeout.

## Ce que pi-agent-core fournit déjà

`@earendil-works/pi-agent-core@0.85.1` exporte depuis son point d'entrée principal (`dist/index.d.ts:23`) `dist/harness/utils/truncate.d.ts` :

- `DEFAULT_MAX_LINES = 2000`, `DEFAULT_MAX_BYTES` = 50 Ko (`:10-11`) — la première limite atteinte gagne ;
- `truncateHead(content, options?)` (`:55`) et `truncateTail(content, options?)` (`:62`), jamais de ligne partielle sauf le cas queue documenté ;
- `TruncationResult` (`:13-40`) avec `truncated`, `truncatedBy`, `totalLines`, `outputLines`, `totalBytes`, `outputBytes`, `lastLinePartial`, `firstLineExceedsLimit`.

Ces trois fonctions sont **pures** : elles prennent une chaîne et rendent une chaîne plus des métadonnées. Rien à adapter, un import suffit. Rakazo n'importe rien de tout ça (aucune occurrence de `truncateHead`/`truncateTail` dans `packages/`).

Le débordement sur fichier, lui, **ne se réutilise pas**. Le propre outil `bash` du harness pi (`dist/harness/tools/bash.js`) fait ce que ce ticket demande — description « Output is truncated to last 2000 lines or 50KB (whichever is hit first). If truncated, full output is saved to a temp file » (`:24`), détails `{ truncation, fullOutputPath }` alimentés par `view.spillPath` (`:57-58`) et `capture.spillPath` (`:76`), marqueur `[Showing last X of line N … Full output: <path>]` (`:81`) — mais le fichier est écrit par l'environnement d'exécution, pas par les utilitaires : `harness/utils/shell-output.d.ts` le dit en toutes lettres, « Source-side capture, adaptive publication, and spilling remain owned by the execution environment », et `spillPath` est un champ de `ShellOutputMetadata` (`harness/types.d.ts:236-240`), pas un retour de `truncate.ts`. Brancher `createBashTool` demanderait un `ExecutionEnv` complet sur la sandbox rakazo (même blocage qu'en 01).

Partage net pour ce ticket : **l'étape 2 se fait par import, les étapes 1 et 3 s'écrivent à la main** en reprenant le vocabulaire de pi (`truncation`, `spillPath`/`fullOutputPath`) pour que les deux mondes restent lisibles ensemble.

Côté grok, `shell-exec/output-limiter.ts` (flush toutes les 50 ms, tampon 256 Ko) et `output-suppression.ts` (`SHELL_OUTPUT_SUPPRESSION_DEFAULTS`, coupe le streaming au-delà de 64 Ko/s avec l'avis `[This shell is producing too much output to stream. The command will still run.]`) gèrent le débit vers l'UI, pas la taille du résultat rendu au modèle. Ils ne répondent pas à ce ticket.

## Ce qu'il faut faire

Trois changements, du plus petit au plus utile :

1. **Plafonner `runSandboxCommand` en mémoire.** Un plafond en octets (par exemple 4 Mo par flux) au-delà duquel on garde une fenêtre glissante de queue et on compte ce qui est jeté. Sans ça, le débordement sur fichier ne peut pas être fidèle et le worker reste exposé.
2. **Remplacer le clip de queue par tête+queue avec marqueur.** Pour `shell`, garder `truncateTail` (le verdict est à la fin) ; pour `read_file` et les résultats de connecteurs, `truncateHead`. Le marqueur dit `[… N lines omitted …]` avec `totalLines` et `totalBytes` du `TruncationResult`. Le budget global de `clipToolResultContent` (`:18-46`) reste le filet de sécurité.
3. **Déborder sur un fichier de la sandbox.** Quand `truncated` est vrai pour `shell`, écrire la sortie complète via `deps.sandbox.writeFile` dans un chemin stable du bot (par exemple `.rakazo/tool-output/<executionId>.txt`) et renvoyer ce chemin dans le résultat. Le modèle relit avec `read_file` — qui gagne au passage un `offset`/`limit` optionnel, sinon relire 4 Mo est impossible (plafond `MAX_MODEL_FILE_BYTES = 250_000`, `executor.ts:348`). `createReadTool` de pi a déjà ce schéma `{ path, offset?, limit? }` (`dist/harness/tools/read.d.ts`) ; reprendre les mêmes noms.

Le résultat de subagent (`pi-runtime.ts:1331`) garde son clip actuel : c'est un texte rédigé par un modèle, pas une sortie de commande, la queue n'y porte pas plus d'information que la tête.

## Interaction avec la rédaction

La rédaction (`redactAgentCommandResult(result, runSecrets)`, `executor.ts:2637`) doit s'appliquer avant l'écriture du fichier de débordement, pas seulement au texte rendu au modèle — sinon le fichier contient les secrets que le résultat clippé avait masqués.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `truncateHead`/`truncateTail` importés depuis `@earendil-works/pi-agent-core` ; aucune fonction de troncature tête/queue réécrite
- [ ] `runSandboxCommand` borne chaque flux en mémoire et rapporte le volume jeté
- [ ] Le résultat de `shell` est tronqué par la queue via `truncateTail`, avec un marqueur qui donne le nombre de lignes omises et le total
- [ ] Les autres résultats texte sont tronqués par la tête via `truncateHead` ; `clipToolResultContent` reste le plafond global
- [ ] Sortie complète de `shell` écrite (rédigée) dans un fichier du bot quand tronquée ; le chemin est dans le résultat
- [ ] `read_file` accepte `offset`/`limit` (lignes) pour relire un débordement par morceaux
- [ ] Tests : sortie de 10 000 lignes → queue de 2 000 avec marqueur exact ; secrets absents du fichier de débordement ; résultat sous la limite inchangé octet pour octet
- [ ] `TOOL_RESULT_TEXT_LIMIT` et le marqueur documentés dans la description de l'outil `shell` pour que le modèle sache lire la fin d'abord
