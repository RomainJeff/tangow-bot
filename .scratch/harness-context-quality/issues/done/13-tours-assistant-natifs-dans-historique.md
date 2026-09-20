# 13: Rendre les tours passés du bot en messages `assistant` natifs

**What to build:** Quand le bot relit sa propre conversation, ses tours précédents arrivent aujourd'hui comme des messages `user` contenant un marqueur texte. Après ce ticket ils arrivent comme des messages `assistant`, la forme sur laquelle les modèles sont entraînés. Le bot n'a plus besoin d'apprendre un protocole de balises dans le prompt pour savoir ce qu'il a dit lui-même — l'information est portée par la structure, où un pair ne peut pas la forger.

## Ce que le cadrage a établi

**Ce n'est pas une contrainte du runtime.** `pi-ai` expose `Message = UserMessage | AssistantMessage | ToolResultMessage`. Les messages `assistant` sont acceptés dans `initialState.messages` d'un `Agent` comme n'importe où ailleurs. L'aplatissement est un choix de Rakazo, pas une limite de pi.

**Le choix est ancien et n'a jamais été rouvert.** `toHistory` filtrait à l'origine *tout sauf* les tours utilisateur : les tours du bot étaient simplement absents de sa propre mémoire. Le commit `a7bf86a3` les a réintroduits en les préfixant `Assistant: `. Le ticket 06 de cette série a remplacé ce préfixe par `<assistant_turn>` avec échappement, parce qu'un préfixe nu est du texte que n'importe quel message peut contenir. Chaque étape a amélioré le marqueur ; aucune n'a touché le `role`.

**Le périmètre est plus petit qu'il n'y paraît — l'aplatissement ne concerne que la réhydratation entre runs.** À l'intérieur d'un run, pi-agent-core empile de vrais `AssistantMessage` et `ToolResultMessage` natifs : la boucle d'outils du tour courant est bien formée. C'est la mémoire longue qui est dégradée, pas le raisonnement immédiat.

**Un seul site d'appel.** `toHistory` n'est appelé qu'en `pi-runtime.ts:264`, plus ses tests. Le chemin sous-agent (`pi-runtime.ts:1128`) construit son `initialState` sans passer par lui. Le rayon d'impact est une fonction et son appelant.

**Ce que le fix ne répare pas.** Un `AssistantMessage` exige `api`, `provider`, `model`, `usage`, `stopReason` — du remplissage mécanique (`usage` à zéro, `stopReason: "stop"`, les trois premiers repris du run courant). En revanche `toolCallId` n'est pas persisté : les appels d'outils historiques **restent du texte rendu** (`[tool name(input) → output]`, ticket 05). Le gain est le rôle et l'attribution, pas le pairing natif `ToolCall`/`ToolResultMessage`. Restaurer celui-là demanderait de persister les identifiants d'appel, ce qui est hors de ce ticket.

**Points d'attention identifiés :**

- `transformContext: pruneComputerScreenshotContext` (`pi-runtime.ts:312`) traverse le contexte et distingue les rôles. Il voit déjà des messages `assistant` produits en cours de run ; à vérifier qu'il se comporte pareil sur des messages `assistant` réhydratés, dont le `content` ne contient que du texte.
- Le `filter((m) => m.role === "user" || m.role === "assistant")` jette silencieusement les lignes stockées en `system`, ce qui rend morte la branche `"system"` de `messageToAgentHistoryTurn` (`reply-context.ts`). Soit on la traite, soit on supprime la branche — ne pas laisser le code mort en place.
- Les marqueurs `<assistant_turn>` ne disparaissent pas partout : les tours des bots pairs restent rendus en blocs `<bot_message from=…>` dans des messages `user`, et l'échappement de `sealAssistantTurnMarkers` reste nécessaire tant que des marqueurs peuvent apparaître dans du contenu entrant.
- Le log `agent.run.context` (`executor.ts:3757`) compte `historyTokens` sans ventilation par rôle. Si la mesure doit comparer avant/après, elle a besoin de cette ventilation.

**Pourquoi maintenant et pas avant.** La question empirique — est-ce que le bot s'attribue moins les décisions de ses pairs avec des rôles natifs ? — n'était pas mesurable jusqu'au ticket 01. Ce ticket devrait être implémenté après une première lecture des compteurs, et décidé conjointement avec le ticket 12 : les deux touchent l'attribution des tours en thread de groupe.

**Blocked by:** Ticket 01 (instrumentation), pour disposer d'une mesure avant/après. Le ticket 06 est mergé et fournit le rendu actuel que ce ticket remplace.

**Status:** done — mergé en `6d2a85d5`

- [ ] Les tours passés du bot arrivent au modèle avec `role: "assistant"` ; ceux des pairs et de l'utilisateur restent `user`
- [ ] Les champs obligatoires d'un `AssistantMessage` sont renseignés à partir du run courant, sans appel réseau ni valeur inventée qui fausserait une mesure de coût
- [ ] Les traces d'outils historiques restent lisibles sous leur forme texte actuelle — aucune régression du ticket 05
- [ ] `pruneComputerScreenshotContext` traite correctement un message `assistant` réhydraté (contenu texte seul)
- [ ] La branche `"system"` de `messageToAgentHistoryTurn` est soit acheminée, soit supprimée — plus de code inatteignable
- [ ] `agent.run.context` ventile les tokens d'historique par rôle, pour que l'effet du changement soit observable
- [ ] Tests couvrant : un tour propre, un tour de pair, un tour contenant des marqueurs `<assistant_turn>` littéraux
- [ ] Entrée CHANGELOG — le comportement du bot en conversation longue est observable par un utilisateur
