# 03: Cadrage — une couche de hooks pour un bot hébergé multi-tenant

**What to build:** Rien pour l'instant. Ce ticket pose les questions qu'il faut trancher avant de décider si rakazo a besoin d'une **couche** de hooks — extensible, multi-handler, avec des règles écrites hors du code — et si oui laquelle.

Ce qu'il ne pose plus : la question du *point d'accroche*. Vérification faite dans `node_modules`, il existe déjà (voir section suivante). Un pré/post-outil unique et une décision de fin de tour sont disponibles aujourd'hui sur l'objet `Agent` que rakazo construit déjà, sans 04 et sans migration. 08 et 10 s'en servent. Ce ticket ne porte plus que sur la gouvernance : qui écrit une règle, et par quel canal.

## Ce que grok appelle « hooks »

`hooks/hook-step.ts:1-8` liste 21 étapes : `beforeShellExecution`, `beforeMCPExecution`, `afterShellExecution`, `afterMCPExecution`, `beforeReadFile`, `afterFileEdit`, `beforeTabFileRead`, `afterTabFileEdit`, `stop`, `beforeSubmitPrompt`, `afterAgentResponse`, `afterAgentThought`, `sessionStart`, `sessionEnd`, `preCompact`, `subagentStart`, `subagentStop`, `preToolUse`, `postToolUse`, `postToolUseFailure`, `workspaceOpen`.

Trois propriétés fixent le modèle :

| Propriété | Où | Ce que ça implique |
|---|---|---|
| Les hooks sont des scripts ou des prompts écrits par l'utilisateur dans la config Cursor | `hooks/claude-code-mapper.ts` (`CursorHookScript { type: "command" \| "prompt", loop_limit, failClosed }`), conversion depuis le format Claude Code | Extension par l'utilisateur final, sur sa machine |
| Six étapes sont des points de permission, réponse `allow \| deny \| ask` | `hooks/types.ts` `PERMISSION_HOOK_STEPS` (`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `beforeTabFileRead`, `subagentStart`, `preToolUse`) ; `validators/preToolUseResponse.ts` : `permission`, `user_message`, `agent_message`, `updated_input`, `additional_context` | Le hook peut refuser, réécrire l'entrée, injecter du contexte |
| Exécution fail-closed | `hooks-exec/hook-error-handling.ts` : `FailClosedError`, `withFailClosed`, `HookDeniedError`, `HOOK_DENIAL_AGENT_NOTE = "Agent note: Do not suggest workarounds to the blocked tool."` | Un hook qui plante bloque l'action |

C'est un mécanisme d'IDE mono-utilisateur : la personne qui écrit le hook est celle dont les fichiers sont en jeu, le script tourne sur sa machine avec ses droits. Rien de ça ne se transpose tel quel à rakazo, où le code du bot tourne dans une sandbox hébergée et où l'opérateur de la plateforme et le propriétaire du bot sont deux rôles distincts.

## Ce que pi-agent-core fournit, et que rakazo n'utilise pas

`@earendil-works/pi-agent-core@0.85.1` offre deux choses très différentes, et la version initiale de ce ticket les confondait.

**Ce qui est déjà là, sur l'objet que rakazo instancie.** `AgentOptions` (`dist/agent.d.ts:5-25`) déclare trois rappels que rakazo laisse vides :

| Rappel | Signature | Ce qu'il peut faire |
|---|---|---|
| `beforeToolCall` | `(ctx: { assistantMessage, toolCall, args, context }, signal?) => Promise<BeforeToolCallResult \| undefined>` | `BeforeToolCallResult { block?, reason?, terminate? }` (`dist/types.d.ts`) — refuser l'appel avec un motif rendu au modèle, ou demander l'arrêt (`terminate` ne coupe que si **tous** les résultats finalisés du lot le demandent) |
| `afterToolCall` | `(ctx: { …, result, isError, context }, signal?) => …` | `AfterToolCallResult { content?, details?, isError?, usage?, terminate? }` — réécrire ou tronquer le résultat avant qu'il n'entre dans le contexte |
| `shouldStopAfterTurn` | `(ctx: { message, toolResults, context, newMessages }, signal?) => boolean \| Promise<boolean>` | arrêter le run en fin de tour sur un état observé |

Rakazo n'en renseigne aucun : `pi-runtime.ts:338-367` (run principal) et `:1213-1240` (subagent) ne passent que `transformContext` (`:344`, `:1222`) et `prepareNextTurnWithContext` (`:346`). Or les outils rakazo **sont** exécutés par cette boucle — `toAgentTools` (`:672`) → `toAgentTool` (`:920`) → `initialState.tools`. Le pré-outil hand-rollé actuel le prouve : `beginToolCall` (`:1795`), appelé dans le `execute` de chaque outil (`:1020`) pour rendre `« Skipped: tool-call limit reached. »`, est exactement un `beforeToolCall` renvoyant `{ block: true, reason }` — mais dupliqué par outil au lieu d'être posé une fois.

Limite réelle : **un seul handler par emplacement**. Si deux besoins veulent le même point, c'est au code rakazo de les composer. C'est suffisant pour un pipeline interne ordonné, insuffisant pour une extension par des tiers.

**Ce qui n'est pas là.** Le registre multi-handler (`harness.hooks: Hooks`, `on(name, handler)`, `agent-harness.d.ts:702`) et ses 11 étapes (`before_run`, `before_drive`, `before_run_end`, `transform_context`, `before_request`, `before_payload`, `after_response`, `before_tool`, `after_tool`, `before_compaction`, `before_navigation`) appartiennent à `AgentHarness`, dont `create(options, context)` exige une `Session` durable, des `Models` et des outils à `ExecutionToolContext`. La classe `HookRegistry` elle-même n'est pas dans la carte `exports` du package — seuls les types `HookMap`/`HookName`/`Hooks` sortent par la racine. Migrer vers `AgentHarness` reste un chantier à part, non cadré, et **il n'est plus sur le chemin critique de ce ticket** : ce qui le justifiait, c'était l'accès à un pré/post-outil, qui existe déjà par ailleurs.

## Ce que rakazo fait déjà à la place

Tout ce qu'un `preToolUse` ferait est aujourd'hui inline dans `applyTool` (`executor.ts:1860-3618`) :

| Rôle | Où | Ligne |
|---|---|---|
| Garde d'entrée (handoff, outils page browser, images) | tête de `applyTool` | `:1866-1874` |
| Décision d'approbation | `viaConnector`, `toolRequiresApproval`, `toolRequiresExplicitApproval`, `resolveActionApprovalDetail({ toolName, connectorKind, rules })` | `:2050-2075` |
| Règles d'approbation par bot | `loadApprovalRules` | `:1671` |
| Revue automatique | `runAutoReview` | `:2127` |
| Politique par outil | `APPROVAL_EXEMPT_TOOLS`, `APPROVAL_REQUIRED_BUILTIN_TOOLS`, `EXPLICIT_APPROVAL_BUILTIN_TOOLS`, `UNATTENDED_SAFE_BUILTIN_TOOLS`, `READ_ONLY_CONNECTOR_PATTERN`, `MUTATING_CONNECTOR_PATTERN` | `packages/core/src/action-approval.ts:3-57` |
| Garde-fou shell | `isProtectedComputerLifecycleCommand` (kill/pkill/systemctl stop…, `eval`/`source`, formes dynamiques) | `executor.ts:511` |
| Post-outil : audit, rédaction, budget | `appendToolCompletionAudit` `:657`, `redactAgentCommandResult` `:2637`, `onToolCompleted` `:3857`, `beginToolCall` `pi-runtime.ts:1795` | |

Rakazo a donc déjà un `preToolUse` et un `postToolUse` — sans le nom, sans point d'accroche unique, et sans possibilité pour un opérateur ou un propriétaire de bot d'y ajouter une règle sans toucher au code. La question n'est pas « ajouter des hooks », c'est « qui doit pouvoir ajouter une règle, et où ».

## Questions à trancher

1. **Qui écrit la règle ?** Trois candidats : l'opérateur de la plateforme (règle globale, par exemple « aucun `shell` ne peut appeler `curl` vers une IP privée » — déjà partiellement fait par `web-ssrf.ts` pour `web_fetch`), le propriétaire du bot (règle par bot, comme les `approvalRules` actuelles), le bot lui-même (non). La réponse conditionne tout : une règle opérateur est du code ou de la config déployée ; une règle propriétaire est une donnée en base avec une UI.
2. **In-process ou externe ?** Un hook grok est un processus enfant. En hébergé multi-tenant, un script fourni par un tenant qui s'exécute dans le worker est exclu ; dans la sandbox du bot il est possible mais c'est alors un outil comme un autre. Un hook in-process écrit par l'opérateur est une fonction TypeScript — c'est un pipeline, pas une couche de hooks.
3. **Quelles étapes ?** Sur les 21 de grok, celles qui ont un équivalent rakazo : `preToolUse`/`postToolUse`/`postToolUseFailure` (applyTool), `subagentStart`/`subagentStop` (`executeSubagent`, `pi-runtime.ts:1155`), `preCompact` (`compactHistory`, `history-compaction.ts:509`), `sessionStart`/`sessionEnd` (début et fin de `continueRun`). Les étapes fichier/onglet et `workspaceOpen` sont de l'IDE. `beforeSubmitPrompt`, `afterAgentResponse`, `afterAgentThought` supposent un humain devant l'écran.
4. **Fail-closed ou fail-open ?** Grok bloque si le hook plante. Pour un bot qui tourne sans humain, un pipeline interne fail-closed transforme un bug de règle en bot muet. À décider par étape, pas globalement.
5. **Relation avec `action-approval.ts`.** Si une règle peut répondre `deny`, elle recouvre une partie de la décision d'approbation. Il faut une seule source de vérité : soit les listes de `action-approval.ts` deviennent la première règle du pipeline, soit le pipeline est en amont et l'approbation n'intervient que sur `ask`. Sinon deux systèmes répondent à la même question.
6. **Faut-il une couche du tout ?** L'alternative minimale ne demande même plus 04 : renseigner `beforeToolCall` / `afterToolCall` dans le `new Agent({…})` existant, et y appeler une liste ordonnée de fonctions internes typées, sans extension externe. Un seul point, deux sites (run principal `:338`, subagent `:1213`), aucune migration. C'est probablement suffisant pour l'opérateur. Ce qui la rendrait insuffisante : plusieurs propriétaires de règles ayant besoin du même emplacement sans se connaître (le slot est mono-handler), ou une demande de propriétaire de bot pour une règle non exprimable par les `approvalRules` actuelles. Aucune des deux n'est connue à ce jour. 04 reste utile pour la lisibilité de `applyTool`, mais n'est plus un préalable.

Ce que 10 ajoute : si une couche de règles existe, l'allowlist opérateur avant dispatch (10) en est la première règle. Si elle n'existe pas, 10 se fait seul dans `beforeToolCall`.

## Ce qu'il faudrait produire

Une note de décision, pas du code : réponse aux six questions, avec pour chaque étape retenue son point d'accroche — `beforeToolCall` / `afterToolCall` pour le pré/post-outil, à identifier pour les autres (`executeSubagent`, `compactHistory`, début et fin de `continueRun`). Si la réponse à la question 6 est « pipeline interne », le ticket se ferme en pointant vers 10.

**Blocked by:** None. La version initiale posait `04` comme préalable au motif qu'aucun point d'accroche n'existait ; c'était faux (`beforeToolCall`/`afterToolCall` sur l'`Agent` déjà instancié). 04 reste souhaitable pour la lisibilité de `applyTool` et peut se faire en parallèle.

**Status:** needs-scoping

- [ ] Répondre aux six questions ci-dessus dans une note courte, avec pour chacune la conséquence sur le code
- [ ] Recenser les règles que les `approvalRules` actuelles ne savent pas exprimer (demande réelle, pas hypothèse) ; si la liste est vide, conclure « pipeline interne, pas de couche »
- [ ] Décider fail-closed / fail-open par étape retenue
- [ ] Décider la source de vérité unique entre pipeline et `action-approval.ts`
- [ ] Décider si le slot mono-handler de `AgentOptions` suffit (composition côté rakazo) ou si un registre multi-handler est requis ; ce second cas seul rouvre la question `AgentHarness`, en ticket séparé
- [ ] Mettre à jour 10 selon la conclusion
