# 05: Assembler le prompt système en blocs typés et ordonnés

**What to build:** Remplacer les littéraux inline de `buildSystemInstructions` par une liste de blocs nommés, chacun avec sa position (préfixe cacheable ou suffixe mobile), sa condition d'inclusion et son budget, rendus dans un ordre déclaré. Le texte produit pour un run donné ne change pas ; ce qui change, c'est qu'on peut tester, budgéter et déplacer un bloc sans relire 34 lignes de template.

## État actuel

`packages/adapters/src/executor.ts:810-874`. Les entrées sont déjà typées : `SystemInstructionParts` (`:810-827`) porte `botInstructions`, `hasHistoricalContext`, `groupContext`, `messagingContext`, `computerInstruction`, `pageBrowserAllowed`, `rememberExposed`, `workspaceInstruction`, `agentEnvironmentInstruction`, `pluginLine`, `agentSkillsLine`, `taughtSkillsLine`, `memoryContext`, `scratchpadContext`, `botDirectory`. Le commentaire `:829-840` documente la contrainte de cache de préfixe. `buildSystemInstructions` (`:841-874`) construit un tableau plat, `.filter(Boolean).join("\n\n")`, avec un commentaire `:866` `// Fragments below move on their own between turns; everything above is the cacheable prefix.` qui sépare le préfixe stable (`botInstructions` → `taughtSkillsLine` et les littéraux) du suffixe mobile (`memoryContext`, `scratchpadContext`, `botDirectory`).

Ce n'est donc pas une concaténation naïve. Le point faible est ailleurs : entre `messagingContext` et `workspaceInstruction`, un littéral de gabarit d'une vingtaine de lignes mélange règles fixes et conditions (`computerInstruction`, `pageBrowserAllowed ? … : …`, `rememberExposed ? … : …`), puis une dizaine de littéraux fixes (bot vs subagent, `create_space`, `spawn_bot`, `update_bot`, `run_subagent`, `archive_bot`, `render_plot`, `add_mcp_server`, secrets, `message_user` 500 caractères) sont des éléments anonymes du tableau. Aucun n'a de nom, de test propre, ou de budget. `computerInstruction` et `workspaceInstruction` sont calculés dans `continueRun` (`:1701-1711`) et injectés comme chaînes.

L'appel est à `:3733-3750` ; `memoryContext` et `scratchpadContext` y sont rédigés avant injection (`:3746-3749`).

## Lien avec `harness-context-quality`

Le ticket 02 de `.scratch/harness-context-quality/` a été fusionné en `c88ba4b6` : c'est lui qui a posé la coupure préfixe/suffixe et le commentaire de `:866`. Ce ticket-ci ne la remet pas en cause. Contrainte dure : le préfixe rendu doit rester **identique octet pour octet** pour un même bot d'un tour à l'autre, sinon le cache de prompt du fournisseur tombe. Toute refonte doit passer un test qui compare le rendu avant/après sur les mêmes `SystemInstructionParts`.

## Ce que grok fait

Grok rend son prompt en JSX (`prompt-jsx/`, composants `System`/`User`/`Assistant`/`Tool`, `renderContent` `:457`) et place des blocs durables dans la compaction (`agent-summarization/durable-blocks.ts`, `DurableBlockId` : `mode-prompt`, `project-root`, `plan`, `transcript`, `automation-trigger`, `todos`, `skills` ; `SUMMARIZERS` donne pour chaque résumeur les blocs `leading` et `trailing` ; `renderDurableBlocks` `:151`, `appendDurableBlocks` `:178`, `prependDurableBlocks` `:184`). L'idée à retenir : un bloc a un identifiant et une position déclarée, pas un rang implicite dans un tableau. Le JSX ne s'applique pas : rakazo n'a pas de rendu multi-rôle, un tableau d'objets suffit.

## Forme proposée

```ts
type PromptBlock = {
  id: string;                          // "untrusted-content", "tools-computer", "subagent-rules", "memory", "scratchpad"…
  zone: "prefix" | "suffix";           // prefix = cacheable, suffix = mobile entre tours
  render: (p: SystemInstructionParts) => string | null;  // null = omis
  maxChars?: number;                   // budget ; dépassement = erreur en test, troncature en prod
};
const PROMPT_BLOCKS: PromptBlock[] = [ /* ordre = ordre de rendu */ ];
```

`buildSystemInstructions` devient : filtrer, rendre, vérifier qu'aucun bloc `suffix` ne précède un bloc `prefix`, joindre par `"\n\n"`. Chaque littéral anonyme actuel devient un bloc nommé avec le même texte. `computerInstruction` et `workspaceInstruction` restent des chaînes fournies par `continueRun` — les déplacer dans un bloc `render` demanderait de passer `computerMode`/`bot` à `buildSystemInstructions`, ce qui n'est pas nécessaire.

Budgets : les seuls blocs qui varient en taille sont `memoryContext`, `scratchpadContext` (déjà borné à `MAX_SCRATCHPAD_CONTEXT_BYTES = 4 * 1024`, `scratchpad-context.ts:4`), `botDirectory`, `botInstructions`. Les mettre en `maxChars` rend la limite lisible à un endroit ; le reste n'en a pas besoin.

## Ce que ça débloque

- Un test par bloc (« `rememberExposed = false` → le bloc `remember` est absent ») au lieu d'un test par `includes` sur la chaîne finale.
- 06 peut ajouter ou modifier le bloc `scratchpad` sans toucher au reste.
- Un futur bloc « règles opérateur » (03/10) a une place déclarée.
- Le comptage de tokens par bloc pour la latence par tour (`harness-context-quality` ticket 17).

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `PromptBlock` et `PROMPT_BLOCKS` dans `executor.ts` (ou un `system-prompt.ts` voisin) ; chaque littéral anonyme actuel devient un bloc nommé, texte inchangé
- [ ] `zone` déclarée par bloc ; assertion qu'aucun `suffix` ne précède un `prefix`
- [ ] Test de non-régression : pour un jeu de `SystemInstructionParts` couvrant les combinaisons `pageBrowserAllowed`/`rememberExposed`/`hasHistoricalContext`, le rendu est identique octet pour octet à l'ancien `buildSystemInstructions`
- [ ] Test de stabilité du préfixe : deux appels avec le même préfixe et des `memoryContext`/`scratchpadContext` différents produisent le même texte jusqu'au premier bloc `suffix`
- [ ] `maxChars` sur `memory`, `scratchpad`, `botDirectory`, `botInstructions` ; dépassement = erreur en test
- [ ] L'appel `:3733-3750` inchangé dans sa signature
