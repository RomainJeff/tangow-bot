# 07: Exécuter une commande shell en arrière-plan sans bloquer le tour

**What to build:** Un mode `background: true` sur l'outil `shell` qui lance la commande, rend immédiatement un identifiant et le chemin d'un fichier de log, et laisse le modèle continuer. Le modèle relit le log avec `read_file` (avec l'`offset`/`limit` de 02). La notification à la fin de la commande est laissée en question ouverte, pas dans le périmètre.

## Ce que rakazo a déjà

Plus qu'il n'y paraît. La branche `shell` (`executor.ts:2604-2637`) n'exécute pas la commande nue : elle l'enveloppe dans `BACKGROUND_WORK_LAUNCH` (`computer-idle.ts:19-25`) via `bash -c … "rakazo-background-launch" <computerId> <runId> <uuid> <command>` (`:2618-2635`). L'enveloppe crée un marqueur `/tmp/rakazo-background-<computer>-<run>-<uuid>` (`BACKGROUND_WORK_MARKER_PREFIX`, `:16`), garde un descripteur ouvert dessus (`exec 9>"$marker"`), puis `exec bash -lc "$4"`. Tant que la commande vit, le descripteur est tenu. Deux consommateurs :

| Consommateur | Où | Rôle |
|---|---|---|
| `CANCEL_COMPUTER_RUN_WORK` | `computer-idle.ts:28+` | tue les enveloppes d'un run annulé en les retrouvant par marqueur |
| `sleepComputerIfIdle` → `sandbox.inspectBackgroundWork?(computer, computerId, context)` | `computer-idle.ts:382-384`, interface `adapter-kit/src/interfaces.ts:104-108`, réponse `"active" \| "idle" \| "unknown"` | empêche la mise en veille de la sandbox si un marqueur est encore tenu |

Donc un processus lancé par `shell` et encore vivant après la fin du tour est déjà traqué, annulable et maintient la machine éveillée. Ce qui manque est en amont : `runSandboxCommand` (`:5348-5382`) attend l'événement `exit` avant de rendre, jusqu'au timeout `sandboxCommandTimeoutMs()` (5 min par défaut, `core/src/sandbox-command.ts:1-9`). Le tour est bloqué pendant toute la durée de la commande. Un `npm run build` de 8 minutes fait échouer l'outil au timeout, et le modèle ne peut rien faire d'autre entre-temps.

Le point de départ suggérait de « regarder `wakeup.ts` ». `packages/adapters/src/wakeup.ts` est l'infrastructure graphile-worker (`GraphileJobPublisher` `:17`, `GraphileJobWorkerHost` `:56`, `InMemoryJobQueue` `:194`) : c'est le bus de jobs, pas un ordonnanceur de réveil. Il servirait si on voulait réveiller un run à la fin d'une commande, mais rien n'y existe pour ça aujourd'hui.

## Ce que grok fait

`agent-exec/background-shell.ts` est une déclaration de ressource RPC ; `background-completion-dispatch.ts` est vide (`export {}`, rien n'a survécu au tree shaking). Ce qui survit : `background-work-registry.ts:254` `InMemoryBackgroundWorkRegistry` (`upsertWork`, `clearWork`, `abortWork`, `hasRunningWork`, `abortAllWork`) et `wakeup/index.ts` (`interface Wakeup { conversationId; id; groupKey? }`, `mergeWakeup`). Le modèle grok est donc : un registre de travaux en cours par conversation, et un signal de réveil fusionnable. Rakazo a l'équivalent du registre côté sandbox (les marqueurs) ; il n'a pas le réveil.

## Périmètre

**Dedans** : le lancement non bloquant.

```
shell { command, cwd?, background?: boolean }
→ background = false : inchangé
→ background = true  : { started: true, job_id, log_path, note: "Use read_file on log_path to check progress." }
```

Implémentation : une seconde enveloppe (ou un paramètre à `BACKGROUND_WORK_LAUNCH`) qui fait `nohup bash -lc "$4" > "$log" 2>&1 & echo $!` et rend tout de suite. Le marqueur est créé de la même façon, tenu par le processus fils — `CANCEL_COMPUTER_RUN_WORK` et `inspectBackgroundWork` fonctionnent sans changement. `log_path` est sous le workspace du bot (le même préfixe que le débordement de 02), pas sous `/tmp`, pour que `read_file` puisse le résoudre via `resolveBotWorkspacePath`. Le `job_id` est l'uuid du marqueur.

Un `shell` en arrière-plan a la même politique d'approbation que `shell` ; la garde `isProtectedComputerLifecycleCommand` (`executor.ts:511`) s'applique à la commande interne, pas à l'enveloppe.

**Dehors** : le réveil à la fin. Deux options, à trancher dans un ticket séparé si le besoin se confirme :

| Option | Coût | Limite |
|---|---|---|
| Rien : le modèle relit le log quand il veut, et un run en `waiting_input` ou terminé ne se réveille pas | 0 | Une commande qui finit après la fin du run n'est jamais vue ; le prochain message utilisateur la découvre |
| Le fils écrit un fichier `done` à côté du log ; un job graphile périodique (via `wakeup.ts`) sonde les `done` des runs actifs et pousse un message système dans le thread | un job, un `select` | Polling ; il faut choisir la cadence et la durée de vie |

La première option suffit pour le cas d'usage initial (une commande longue pendant un tour qui continue). Ne pas construire la seconde sans une trace de run qui montre le besoin.

**Blocked by:** None (can start immediately) — bénéficie de 02 pour `read_file` `offset`/`limit`

**Status:** ready-for-agent

- [ ] `shell` accepte `background?: boolean` (`builtin-tools.ts:160`), description qui explique le résultat et comment suivre
- [ ] Enveloppe de lancement détaché qui crée le même marqueur que `BACKGROUND_WORK_LAUNCH`, redirige vers un log sous le workspace du bot, rend `{ job_id, log_path }` sans attendre
- [ ] `CANCEL_COMPUTER_RUN_WORK` tue aussi les processus détachés d'un run annulé (test sur `fake-sandbox` avec `inspectBackgroundWork`)
- [ ] `log_path` lisible par `read_file` ; le log passe par la rédaction à la lecture comme tout fichier
- [ ] Test : `background: true` rend en moins d'une seconde pour un `sleep 30` ; le marqueur est `active` pendant, `idle` après
- [ ] Le réveil à la fin reste hors périmètre ; le ticket note les deux options
