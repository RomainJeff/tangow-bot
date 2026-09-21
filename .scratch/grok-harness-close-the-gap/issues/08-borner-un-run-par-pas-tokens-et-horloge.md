# 08: Borner un run par pas, par tokens et par horloge

**What to build:** Trois bornes par run, persistées avec le run et non dans la mémoire du worker : nombre total d'appels d'outils, tokens consommés, temps écoulé. Dépassement = le run se termine proprement avec un message au thread, pas un timeout de lease. Et une détection de boucle qui voit les oscillations, pas seulement les répétitions exactes.

## Ce qui existe

Le point de départ disait « le guard de boucle est tout ce qu'il y a ». Faux. Inventaire :

| Borne | Où | Valeur | Portée |
|---|---|---|---|
| Répétitions identiques d'un appel d'outil | `tool-loop.ts:4` `MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS = 6`, `advanceToolCallLoopGuard` `:6-16`, `trackToolCallStreak` `core/src/events.ts:290-297` | 6 | clé `${name}:${JSON.stringify(args)}` — exact seulement |
| Appels d'outils par tour | `pi-runtime.ts:159-165` `maxToolCallsPerTurn()` env `MAX_TOOL_CALLS_PER_TURN` ; `ToolCallBudget` `:113-118` ; `toolCallBudgetsByRun` `:120` | non défini = illimité | **process-local** : le commentaire `:119` dit « continueRun on another worker starts at zero » |
| Continuations silencieuses | `pi-runtime.ts:133` `MAX_SILENT_TOOL_CONTINUATIONS = 3`, `:436-452` | 3 | par tour |
| Lease du run | `executor.ts:1146` `leaseExpiresAt = now + 5 min`, `renewRunLease` `:4654-4662` | 5 min, renouvelé | protège contre un worker mort, pas contre un run qui tourne trop |
| Commande sandbox | `core/src/sandbox-command.ts:1-9` `SANDBOX_COMMAND_TIMEOUT_MS` | 5 min, max 60 | par commande |
| Stream modèle | `pi-runtime-limits.ts:4` `MODEL_STREAM_TIMEOUT_MS = 120_000`, `:6` `MODEL_STREAM_MAX_RETRIES = 1` | 2 min | par appel modèle |
| Subagents parallèles | `pi-runtime.ts:129` `MAX_PARALLEL_SUBAGENTS = 4` | 4 | par run, process-local (`createGate`, `:266`) |

Ce que ça donne en pratique : un run qui alterne `read_file(a)`, `read_file(b)`, `read_file(a)`, `read_file(b)` n'est jamais arrêté (le streak retombe à 1 à chaque changement). Un run qui fait 400 appels d'outils différents non plus, sauf si l'opérateur a posé `MAX_TOOL_CALLS_PER_TURN` — et alors le compteur repart de zéro si le run est repris par un autre worker après un `waiting_input`. Aucune borne en tokens : le coût d'un run n'est borné que par la patience du modèle. Aucune borne en temps mur : un run peut durer des heures à 5 minutes de lease renouvelé à chaque fois.

Quand le streak déclenche, le traitement `executor.ts:4131-4170` est propre : flush des outils en attente, renouvellement du lease, publication du message partiel, checkpoint. C'est le bon modèle pour les nouvelles bornes.

**Deux points d'accroche existent déjà et ne sont pas utilisés.** `AgentOptions` de pi (`dist/agent.d.ts:13-15`) expose `beforeToolCall`, `afterToolCall` et `shouldStopAfterTurn` ; rakazo ne renseigne que `transformContext` et `prepareNextTurnWithContext` (`pi-runtime.ts:344-346`, `:1222`). Concrètement :

- `beginToolCall` (`pi-runtime.ts:1795`), appelé dans le `execute` de **chaque** outil (`:1020`) pour rendre `« Skipped: tool-call limit reached. »`, et `maybeAbortToolCallBudget` (`:1789`) sont une réimplémentation manuelle et dupliquée de `beforeToolCall`, dont le retour `{ block, reason, terminate }` dit exactement ça. Le plafond par run se pose une fois là, pas une fois par outil.
- `shouldStopAfterTurn(ctx)` reçoit `{ message, toolResults, context, newMessages }` en fin de tour — c'est le point naturel pour évaluer les bornes tokens et horloge, sans plomberie d'arrêt dédiée.

Le stockage (colonnes de run) et le message au thread restent à écrire ; le *déclenchement* ne demande pas de mécanisme nouveau.

## Ce que grok fait

`agent-core/goal-continuation.ts` (`GoalState`, helpers d'horloge) est ce qui survit d'un mécanisme de continuation d'objectif borné dans le temps ; le reste a disparu au tree shaking. Pas de valeur à copier. Ce que retenir : la borne est un état de l'objectif, pas du processus.

## Ce qu'il faut faire

0. **Se brancher sur les rappels pi existants** plutôt que d'ajouter une plomberie d'arrêt : plafond d'appels dans `beforeToolCall` (`{ block: true, reason }`), bornes tokens et horloge dans `shouldStopAfterTurn`. Renseignés aux deux sites `new Agent({…})` (`pi-runtime.ts:338`, `:1213`).
1. **Persister les compteurs sur le run.** Trois colonnes (ou un JSON) sur la ligne de run : `toolCalls`, `tokens` (in + out, tels que le fournisseur les rapporte), `startedAt` existe déjà (`packages/db/prisma/schema.prisma:587`, `model Run` `:562`, `leaseExpiresAt` `:580`). Incrémentés à `onToolCompleted` (`executor.ts:3857`) et à la fin de chaque appel modèle. `toolCallBudgetsByRun` disparaît au profit de la ligne de run.
2. **Trois plafonds par bot, avec défaut plateforme.** `maxToolCallsPerRun` (défaut : 200), `maxTokensPerRun` (défaut : à fixer sur un percentile des runs existants — mesurer avant), `maxRunWallClockMs` (défaut : 60 min). Surchargeables par bot dans ses réglages ; l'env `MAX_TOOL_CALLS_PER_TURN` reste comme plafond plateforme si présent — sa logique déménage simplement dans `beforeToolCall` avec le reste.
3. **Arrêt propre.** Dépassement → même chemin que le streak `:4131-4170` : flush, message au thread qui dit quelle borne et où en est le travail (le scratchpad porte l'état, 06), run en `completed` avec une raison. Pas `failed` : le bot n'a pas planté, il a été arrêté.
4. **Oscillation.** Remplacer la clé exacte par une fenêtre : sur les 12 derniers appels, si l'ensemble des clés distinctes a une taille ≤ 2 et chaque clé apparaît ≥ 3 fois, c'est une boucle. Ça attrape A/B/A/B sans toucher aux séquences légitimes (lire 12 fichiers différents = 12 clés).

Ce qui n'est pas dans ce ticket : un budget monétaire (le prix par token dépend du modèle et n'est pas en base), la borne des subagents (09), une *nouvelle* borne par tour en plus de la borne par run (`MAX_TOOL_CALLS_PER_TURN` survit, inchangé dans son effet).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Schéma : compteurs `toolCalls`, `tokens` persistés sur le run ; migration Prisma
- [ ] `beforeToolCall` et `shouldStopAfterTurn` renseignés dans les deux `new Agent({…})` (`pi-runtime.ts:338`, `:1213`) ; `beginToolCall` retiré du `execute` de chaque outil (`:1020`)
- [ ] Incrément à `onToolCompleted` et après chaque réponse modèle ; `toolCallBudgetsByRun` supprimé
- [ ] Plafonds `maxToolCallsPerRun`, `maxTokensPerRun`, `maxRunWallClockMs` avec défauts plateforme et surcharge par bot ; défaut tokens fixé après mesure sur les runs existants
- [ ] Dépassement → arrêt propre par le chemin de `:4131-4170`, message au thread avec la borne atteinte, run `completed` avec raison
- [ ] `advanceToolCallLoopGuard` remplacé ou complété par une fenêtre glissante qui détecte A/B/A/B ; `MAX_CONSECUTIVE_IDENTICAL_TOOL_CALLS` conservé pour le cas exact
- [ ] Test : run repris par un second worker après `waiting_input` → le compteur continue, ne repart pas de zéro
- [ ] Test : 100 appels distincts sous le plafond → pas d'arrêt ; oscillation A/B ×6 → arrêt
