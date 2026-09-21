# 09: Décision — rendre les subagents durables ou assumer l'éphémère

**What to build:** Une décision, pas du code. Soit les subagents deviennent des runs à part entière (persistés, reprenables, visibles), soit on documente qu'ils sont éphémères et on borne ce que ça coûte. Les deux sont défendables ; l'état actuel — ni l'un ni l'autre — ne l'est pas.

## Ce qu'un subagent est aujourd'hui

`run_subagent` (`builtin-tools.ts:753`) est déclaré comme outil ; la branche `executor.ts:3302` rend `{ ok: true, result: args.task }` et le vrai travail est dans `pi-runtime.ts:1155` `executeSubagent` :

| Étape | Ligne | Ce qui se passe |
|---|---|---|
| Profondeur | `:1156` | `if (host.depth > 0) return "Subagents cannot nest further."` — un seul niveau |
| Porte | `:1157` | `await host.subagentGate.acquire()` ; `subagentGate: createGate(MAX_PARALLEL_SUBAGENTS)` `:266`, `MAX_PARALLEL_SUBAGENTS = 4` `:129` |
| Instanciation | `:1213` | `new Agent({ … })` imbriqué, dans le même processus, avec le même `runSecrets` |
| Exécution | `:1304` | `nested.prompt(task || "Complete the delegated task.")` |
| Résultat | `:1331` | `clipToolResultText(result, 12_000)` rendu au parent comme résultat d'outil |
| Fin | `:1345-1348` | `host.nestedAgents.delete(nested)`, `subagentGate.release()` |

Rien n'est persisté : pas de ligne de run, pas de thread, pas de lease. Si le worker meurt pendant un subagent, le parent est repris par un autre worker (lease 5 min, `executor.ts:1146`) et le subagent a disparu : le parent revoit son appel `run_subagent` sans résultat et le relance de zéro. Si le subagent boucle, il tombe sous les bornes du parent (08) et rien d'autre. Les traces Langfuse le voient comme un span de l'outil `run_subagent` (`pi-run-trace.ts:150-168`), pas comme un run.

La porte est process-locale (`createGate`, `pi-runtime.ts:1832`) : `MAX_PARALLEL_SUBAGENTS` borne par worker, pas par bot ni par tenant. Deux runs du même bot sur deux workers peuvent avoir 8 subagents.

Le point de départ mentionnait `takeover-resume.ts` comme piste. Le fichier (75 lignes) ne connaît que deux checkpoints, `"takeover"` et `"takeover-skipped"` (`:1-5`) : c'est la reprise après une prise de contrôle humaine, sans lien avec les subagents.

## Ce que grok fait

Rien de vérifiable. `agent-exec/subagent-queue.ts` (144 octets), `subagent-lifecycle-state-machine.ts` et `subagent-lifecycle-store.ts` sont tous vides (`export {}`, commentaire « No named runtime surface survived tree shaking »). Les noms de fichiers disent qu'une file, une machine à états et un store existaient ; leur contenu n'est pas dans la reconstruction. Ce dossier ne peut pas s'appuyer sur grok pour ce ticket, et il ne prétend pas le faire.

## Les deux options

**A — Durable.** Un subagent est un `Run` (`schema.prisma:562`) avec un `parentRunId`, son propre lease, son propre état (`run-state.ts:13-17`), ses propres compteurs (08). Le parent se met en `waiting_input` d'un genre nouveau (`waiting_subagent`) et est réveillé par un job quand l'enfant se termine. La porte devient une requête `count(*) where parentRunId = ? and status in (leased, running)` — donc par bot, pas par worker.

Coût : une transition d'état, un job de réveil, un changement de `executeSubagent` qui cesse d'instancier un `Agent` imbriqué pour enfiler un run. Le résultat de l'enfant arrive au parent comme aujourd'hui, un bloc outil. Gains : reprise après crash, visibilité (un subagent est un run dans l'UI et dans les traces), borne par tenant, pas de subagent orphelin.

Ce que ça casse : la latence. Aujourd'hui l'enfant démarre en mémoire ; demain il attend qu'un worker prenne le job. Pour un subagent de 10 secondes c'est un doublement possible.

**B — Éphémère assumé.** On garde l'implémentation et on ferme les trous :

- documenter dans la description de `run_subagent` (`builtin-tools.ts:753`) qu'un subagent ne survit pas au run parent et qu'une tâche longue ne doit pas y aller ;
- borner l'enfant explicitement : durée max (par exemple 10 min) et appels d'outils max, avec le résultat partiel rendu au parent au lieu d'un échec ;
- rendre la porte par bot en la stockant sur le run parent (un compteur `activeSubagents` sur la ligne `Run`, incrémenté/décrémenté en transaction) au lieu d'un `createGate` en mémoire ;
- à la reprise d'un run parent par un autre worker, insérer dans le thread un bloc outil « subagent interrompu par une reprise de worker » pour que le modèle sache qu'il doit relancer.

Coût : petit. Ce que ça ne règle pas : un subagent de 40 minutes reste un pari sur la survie du worker.

## Critère de choix

Ce qui départage, c'est la durée réelle des subagents. Si le p95 est sous 2 minutes, B suffit et A paie de la latence pour un cas rare. Si des subagents dépassent 10 minutes régulièrement, A. La mesure est à faire sur les traces existantes (durée du span `run_subagent`) avant de décider ; sans traces, B d'abord, A plus tard.

**Blocked by:** None (can start immediately) — 08 rend la borne de l'option B triviale

**Status:** needs-decision

- [ ] Mesurer la distribution de durée des spans `run_subagent` sur les traces disponibles ; sans traces, poser l'export (`70175e11`, `005c0a4d`) et attendre une semaine
- [ ] Choisir A ou B sur ce critère ; écrire la décision et sa raison dans ce ticket
- [ ] Si B : quatre points ci-dessus, chacun testable seul ; le bloc « subagent interrompu » testé avec un `fake` worker qui meurt en cours
- [ ] Si A : ticket de conception séparé (transition d'état, job de réveil, `parentRunId`), ce ticket se ferme dessus
- [ ] Dans les deux cas : la porte `MAX_PARALLEL_SUBAGENTS` devient par bot et persistée, pas par worker en mémoire
