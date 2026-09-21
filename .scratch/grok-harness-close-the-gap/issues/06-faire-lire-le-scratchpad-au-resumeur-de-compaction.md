# 06: Faire lire le scratchpad au résumeur de compaction

**What to build:** Passer le scratchpad du bot au résumeur de compaction, et retirer du gabarit de résumé les sections qui dupliquent ce que le scratchpad tient déjà. Aujourd'hui le résumé et le scratchpad produisent deux listes de « prochaines étapes » qui divergent, et le modèle voit les deux à chaque tour.

## Ce qui est vrai et ce qui ne l'est pas

Le point de départ disait « la compaction perd les blocs durables (scratchpad) ». C'est faux par construction : le scratchpad n'est jamais dans l'historique compacté. Il est chargé à chaque tour (`loadAgentScratchpadContext`, `scratchpad-context.ts:7-48`, borné à `MAX_SCRATCHPAD_CONTEXT_BYTES = 4 * 1024` et `MAX_OPEN_ITEMS = 40`), rédigé et injecté comme `scratchpadContext` dans le suffixe mobile du prompt système (`executor.ts:3746-3749`, rendu à `:868`). La compaction, elle, ne lit que les lignes persistées du thread (`history-compaction.ts:553` et `:586`, `select: { seq, role, blocks, botId }`). Elle ne peut pas perdre ce qu'elle ne voit pas.

Le mécanisme de grok qu'on cherchait — `durable-blocks.ts` qui replace `plan`, `todos`, `skills` en tête ou en queue du résumé selon le résumeur — répond à un problème que rakazo n'a pas : chez grok le plan et les todos vivent dans la conversation et doivent survivre au résumé ; chez rakazo ils vivent hors conversation. De même `context-stripping.ts` (23 balises à retirer avant résumé, `CONTEXT_TAGS_TO_STRIP`) n'a pas d'objet ici : rakazo n'injecte pas de contexte balisé dans les messages utilisateur, il le met dans le prompt système, que la compaction ne voit pas non plus.

## Le vrai écart

Le gabarit du résumeur (`history-compaction.ts:296-322`) demande des sections `Goal`, `Constraints & Preferences`, `Progress` (avec `Done`, `In Progress`, `Blocked`), `Key Decisions`, `Next Steps`, `Critical Context`. `Progress` et `Next Steps` sont une liste de tâches. Le scratchpad, alimenté par `scratchpad_add`/`scratchpad_update`/`scratchpad_complete` (`executor.ts:2748-2787`, outils `builtin-tools.ts:563-620`), est aussi une liste de tâches.

Le run de compaction est lancé avec `history: []` et `tools: []` (`:700-716`) : le résumeur voit la fenêtre de transcript (bornée à `MAX_TRANSCRIPT_CHARS = 40_000`, `:236`) et rien d'autre. Il ne sait pas ce que le scratchpad dit. Il rédige donc `Progress`/`Next Steps` à partir des messages, avec un vocabulaire et un découpage qui ne sont pas ceux du scratchpad.

Au tour suivant, le modèle reçoit le résumé (`formatCompactedSummary`, `:103-105`, jusqu'à `MAX_COMPACTED_SUMMARY_CHARS = 20_000`, `:56`) dans l'historique et le scratchpad dans le prompt système. Deux listes. Quand elles divergent, le modèle en choisit une — sans règle. Les 3 000 mots (`SUMMARY_MAX_WORDS`, `:333`) et 12 000 tokens hors historique (`NON_HISTORY_TOKEN_ESTIMATE`, `:123`) budgétés paient en partie pour un doublon.

## Ce qu'il faut faire

Deux changements, l'un sans l'autre est incomplet :

1. **Passer le scratchpad au résumeur.** Dans `compactHistory` (`:509`), charger le scratchpad du bot (même `loadAgentScratchpadContext`, même rédaction qu'à `executor.ts:3746`) et l'insérer dans le prompt du résumeur, avant le transcript, sous un titre clair (« The bot's task list, maintained outside this transcript — do not restate it »). Le résumeur peut alors lier `Progress` au scratchpad au lieu de le réinventer.
2. **Retirer les sections dupliquées du gabarit.** `Next Steps` disparaît ; `Progress` devient « Progress not tracked in the task list » ou disparaît aussi. `Key Decisions` et `Critical Context` restent : c'est ce que le scratchpad ne porte pas et que le transcript seul contient. `SUMMARY_MAX_WORDS` peut baisser d'autant.

Le cas où le scratchpad est vide : le gabarit garde une section `Progress` réduite, conditionnée sur l'absence d'items ouverts. Un bot qui n'utilise pas le scratchpad ne doit pas perdre son suivi de progression dans le résumé.

Le budget de tokens du run de compaction change peu : le scratchpad rend au plus 4 Ko.

## Ce qui n'est pas dans ce ticket

- Faire du scratchpad un « bloc durable » replacé dans l'historique compacté : il est déjà dans le prompt système à chaque tour.
- Le déplacement ou la position du bloc `scratchpad` dans le prompt : c'est 05.
- Les `MAX_LEARNED_FACTS = 10` (`:351`) : le mécanisme des faits appris est distinct et n'a pas de doublon connu.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `compactHistory` charge le scratchpad du bot via `loadAgentScratchpadContext` et le rédige avec les secrets du bot — `compactHistory` n'en charge aucun aujourd'hui (seul `redactSensitiveText` sur les faits appris, `:471`), les résoudre comme `continueRun` le fait à `executor.ts:1579`
- [ ] Le scratchpad est inséré dans le prompt du résumeur avant le transcript, sous un titre qui interdit de le reformuler
- [ ] Gabarit `:296-322` : `Next Steps` retiré ; `Progress` conditionné à l'absence d'items ouverts dans le scratchpad
- [ ] `SUMMARY_MAX_WORDS` revu à la baisse (mesurer sur un échantillon avant de fixer)
- [ ] Test : scratchpad à 3 items ouverts → le résumé ne contient pas de section `Next Steps` et ne recopie pas les 3 items ; scratchpad vide → section `Progress` présente
- [ ] Test : scratchpad contenant un secret du run → absent du prompt du résumeur
