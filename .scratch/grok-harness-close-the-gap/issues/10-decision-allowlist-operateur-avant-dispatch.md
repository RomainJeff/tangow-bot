# 10: Décision — une allowlist opérateur avant le dispatch

**What to build:** Décider si la plateforme a besoin d'un filtre opérateur — global, indépendant des règles par bot — qui refuse un appel d'outil avant tout le reste, et si oui sous quelle forme. Le dispositif actuel est déjà riche ; ce ticket recense ce qu'il ne couvre pas.

## Ce que rakazo vérifie déjà avant d'exécuter un outil

Le point de départ disait « aucun precheck avant dispatch ». Inexact : il y en a six, à des endroits différents.

| Garde | Où | Ce qu'elle décide | Qui la configure |
|---|---|---|---|
| Gardes de tête de `applyTool` | `executor.ts:1866-1874` | outil page browser sans navigateur autorisé, outil image sans support image, run déjà transféré | code |
| Validation d'arguments spécifique | `:1897` (`cloud_agent`) | arguments invalides | code |
| Décision d'approbation | `:2050-2075` : `viaConnector`, `unattendedTriggerToolRequiresApproval`, `toolRequiresApproval`, `toolRequiresExplicitApproval`, `resolveActionApprovalDetail({ toolName, connectorKind, rules })` | exempt / requiert approbation / requiert approbation explicite | listes en code + `approvalRules` par bot (`loadApprovalRules`, `:1671`) |
| Politique par outil et par verbe | `core/src/action-approval.ts` : `APPROVAL_EXEMPT_TOOLS` `:3-23`, `APPROVAL_REQUIRED_BUILTIN_TOOLS` `:25-35`, `EXPLICIT_APPROVAL_BUILTIN_TOOLS = ["create_space"]` `:36`, `UNATTENDED_SAFE_BUILTIN_TOOLS` `:38-53`, `READ_ONLY_CONNECTOR_PATTERN` `:55`, `MUTATING_CONNECTOR_PATTERN` `:56-57` | même chose, par nom | code |
| Commandes shell protégées | `executor.ts:511` `isProtectedComputerLifecycleCommand` : `kill`/`pkill`/`killall`/`xkill`, `eval`/`source`/`.`, `systemctl \| service stop\|restart\|kill`, formes dynamiques | refus | code |
| Réseau sortant de `web_fetch` | `core/src/web-ssrf.ts:13-15` (`DEFAULT_TIMEOUT_MS = 15_000`, 5 Mio, `MAX_REDIRECTS = 5`, IP privées) ; `connector-safety.ts:24-32` `sanitizeConnectorError` | refus / nettoyage | code |

Toutes sont soit du code, soit des règles par bot. Ce qui n'existe pas : une règle **opérateur** modifiable sans déploiement, qui s'applique à tous les bots d'une instance, et qui peut refuser un outil ou un motif d'arguments.

## Ce que grok fait

`agent-exec/mcp-allowlist-precheck.ts`, `shell-allowlist-precheck.ts`, `web-fetch-allowlist-precheck.ts` sont des déclarations de ressources RPC (`createResource<Executor<…>>`) : le nom dit qu'un precheck d'allowlist tourne avant chaque exécution shell, MCP et fetch ; l'implémentation est dans l'IDE. Côté hooks, les six `PERMISSION_HOOK_STEPS` (`hooks/types.ts`) répondent `allow | deny | ask`. Le motif : une décision ternaire, prise avant le dispatch, par une source de règles que l'utilisateur configure. Chez grok l'utilisateur est l'opérateur ; chez rakazo ce sont deux rôles.

## Cas qui manquent aujourd'hui

Les cas qu'une allowlist opérateur couvrirait et que rien ne couvre :

1. Interdire un outil intégré pour toute l'instance (par exemple `spawn_bot` ou `add_mcp_server` pendant un incident) sans redéployer.
2. Interdire un motif de commande shell qui n'est pas dans `isProtectedComputerLifecycleCommand` (`curl … | sh`, `rm -rf /`, `dd`), ou l'inverse : autoriser `kill` pour un bot qui gère ses propres processus.
3. Interdire un domaine ou un hôte pour `web_fetch` au-delà des IP privées.
4. Restreindre un connecteur à ses verbes de lecture pour un tenant donné.

Aucun de ces cas n'a été demandé. Ils sont plausibles pour une plateforme hébergée ; ils ne justifient pas de construire avant qu'un survienne.

## Forme, si on le fait

Sans 03 : une fonction `operatorPrecheck(name, args, bot): "allow" | "deny"` appelée depuis `beforeToolCall`, le rappel de `AgentOptions` (`dist/agent.d.ts:13`) que rakazo laisse vide dans ses deux `new Agent({…})` (`pi-runtime.ts:338`, `:1213`). Il reçoit `{ toolCall, args, context }` et son retour `{ block: true, reason }` est exactement la forme d'un refus. C'est un seul emplacement en amont de tous les outils, y compris ceux des subagents — préférable à un appel en tête de `applyTool`, qui vaut aussi mais se place plus bas et n'est pas le point par lequel la boucle passe déjà. Les règles viennent d'une table `OperatorToolRule { tool: string | "*", argPattern?: string, decision, reason }` lue au début du run à côté de `loadApprovalRules` (`executor.ts:1671`) et passée à `pi-runtime` avec le reste du contexte de run — le rappel est en amont de `applyTool`, il ne peut pas aller la chercher lui-même. Un `deny` rend au modèle un résultat `{ error: "This tool is disabled by the operator: <reason>" }` avec la note anti-contournement de grok (`HOOK_DENIAL_AGENT_NOTE`, `hooks-exec/hook-error-handling.ts`) : « Do not suggest workarounds to the blocked tool. » Pas de `ask` : `ask` est déjà la décision d'approbation, il ne faut pas deux chemins vers la même pause.

Avec 03 : la même fonction est la première règle du pipeline `preToolUse`. Le contenu ne change pas, et l'emplacement non plus — le pipeline de 03, s'il se fait, s'installe derrière ce même `beforeToolCall`.

La source de vérité (question 5 de 03) : `operatorPrecheck` tourne **avant** `action-approval.ts` et ne connaît pas l'approbation ; l'approbation ne connaît pas l'opérateur. Un `deny` opérateur n'est pas une approbation refusée, c'est un outil qui n'existe pas pour ce tenant. Ça évite de fusionner deux systèmes.

## Ce qu'il faut décider

- Un des quatre cas ci-dessus est-il attendu dans les six mois ? Sinon, fermer et rouvrir sur demande.
- Si oui : règles en base (modifiables par l'opérateur à chaud) ou en configuration déployée (plus simple, redéploiement pour changer) ? Le cas 1 (« pendant un incident ») penche pour la base.

**Blocked by:** None. `beforeToolCall` existe et est libre ; ce ticket n'attend ni 03 ni 04. Si 03 conclut à un pipeline, celui-ci s'installe derrière le même rappel et `operatorPrecheck` en devient la première règle sans déménager.

**Status:** needs-decision

- [ ] Répondre : lequel des quatre cas est attendu, par qui, quand ; si aucun, fermer le ticket avec cette raison
- [ ] Si oui : base ou config ; écrire la décision ici
- [ ] `operatorPrecheck` appelé depuis `beforeToolCall` aux deux sites `new Agent({…})` (`pi-runtime.ts:338`, `:1213`) ; `deny` → `{ block: true, reason }` avec note anti-contournement, pas une exception
- [ ] Pas de `ask` ; l'approbation reste le seul chemin vers `waiting_input`
- [ ] Test : règle `tool: "shell", argPattern: "curl .*\\| *sh"` → refus ; même commande sans règle → passe aux gardes existantes
- [ ] Si 03 aboutit à un pipeline, l'installer derrière le même `beforeToolCall` ; `operatorPrecheck` devient sa première règle, sans déménager
