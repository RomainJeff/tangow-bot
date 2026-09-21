# 11: Rédacter l'enregistrement de session Pi JSONL

**What to build:** Appliquer la rédaction des secrets du run aux messages et au prompt système écrits par `PiJsonlSessionRecorder`. C'est le seul puits de sortie du harness qui reçoit du texte non rédigé ; il est opt-in et déjà documenté comme impropre au multi-tenant, ce qui en fait un ticket de basse priorité mais court.

## Où la rédaction s'applique déjà

Le point de départ disait « rédaction opt-in par site d'appel, l'export de traces n'est pas rédigé ». La seconde moitié est fausse ; la première est vraie dans la forme et sans conséquence dans les faits. Inventaire des puits :

| Puits | Rédigé ? | Où |
|---|---|---|
| Résultat de `shell` vers le modèle | oui | `executor.ts:2637` `redactAgentCommandResult(result, runSecrets)` (`agent-environment.ts:33`) |
| Contenu de `read_file` vers le modèle | oui | `:2448` `redactSecrets(...)` |
| Streaming vers l'utilisateur | oui | `:1780` `progressRedactor = createStreamingRedactor(runSecrets)` (`core/src/events.ts:466`) |
| Blocs publiés au thread | oui | `redactBlocks(messageSegments, runSecrets)` `:4948`, utilisé par exemple `:4138` |
| Mémoire et scratchpad dans le prompt système | oui | `:3746-3749` |
| Export de traces Langfuse | **oui** | `pi-runtime.ts:540-548` `redact: (text) => redactSensitiveText(redactSecrets(text, [...secrets]))` ; appliqué à toute valeur par `otlpValue(value, redact)` (`trace-export.ts:199-205`) ; textes bornés à `MAX_TRACE_TEXT = 20_000` (`pi-run-trace.ts:7`) |
| Audit de complétion d'outil | n/a | `toolCompletionAuditPayload` `:614-655` ne stocke que des métadonnées (nom, durée, taille), pas le contenu |
| **Enregistrement de session Pi JSONL** | **non** | `pi-runtime.ts:388` `await piSession?.appendMessage(event.message)` ; `pi-session.ts:200` `systemPrompt: input.systemPrompt`, `:218-220` `appendMessage` → `JsonlSessionRepo` sans transformation |

`redactSecrets` (`core/src/events.ts:366`) est appelé 36 fois dans `executor.ts`. C'est bien « par site d'appel », mais chaque puits qui sort du processus est couvert, sauf un. Passer à une rédaction centrale (par exemple dans `finish`, `:2367`) changerait la structure sans fermer de trou supplémentaire ; ce n'est pas ce ticket.

## Le trou

`PiJsonlSessionRecorder` (`pi-session.ts:153-175`) écrit sous `DATA_DIR/pi-sessions/<user>/<bot>/` (`resolvePiSessionRoot` `:37-42`, `piSessionBotRoot`) via `NodeExecutionEnv` (`:6`, `:161`) et `JsonlSessionRepo` de pi. Il reçoit :

- le prompt système complet au démarrage (`pi-runtime.ts:305-312`, `systemPrompt`, `initialMessages: history`) — y compris mémoire et scratchpad déjà rédigés, donc ce bloc-là est propre ;
- chaque message de l'agent (`:388`) : `event.message` est le message tel que pi l'a construit, donc le résultat d'outil tel que `applyTool` l'a rendu — déjà rédigé pour `shell` et `read_file`. Ce qui n'est pas rédigé : le texte de l'assistant lui-même (s'il recopie un secret vu ailleurs), les arguments d'appels d'outils (`write_file { content }` avec un secret dedans), et tout résultat d'outil d'une branche qui n'appelle pas `redactSecrets` — les appels de connecteurs (`:1902-2045`, seul `sanitizeConnectorError` sur les erreurs) et `web_fetch` (`:2715`, `webFetchFromTool` sans rédaction, `web-tools.ts:26`).

C'est activé par `PI_SESSION_RECORDING=true` (`apps/api/src/env.ts:118`) et `.env.example:66-68` dit : « Opt-in Pi JSONL session recording under DATA_DIR/pi-sessions. Default off: transcripts are unencrypted on disk and unsuitable for multi-tenant hosted DATA_DIR. » Le risque est donc connu et le défaut est bon. Ce qui reste : un développeur qui l'active en local avec des secrets réels, ou un opérateur qui l'active en production pour déboguer.

## Ce que grok fait

`redaction/` (`PrivacyMode`, `createRedactedString`, `shouldRedact`) est une rédaction par mode de confidentialité au niveau du type de chaîne, pas par liste de secrets. Ça ne s'applique pas : rakazo connaît ses secrets (`runSecrets`), grok non.

## Ce qu'il faut faire

`PiSessionRecorder.start` reçoit déjà tout ce qu'il faut de `pi-runtime.ts:305-312`. Ajouter `secrets: string[]` à `PiSessionStart`, et dans `PiJsonlSessionHandle.appendMessage` (`pi-session.ts:218`) passer le message par la même fonction que `redactBlocks` avant `this.session.appendMessage`. Le prompt système est déjà propre ; le rédiger aussi coûte une ligne et évite d'y penser.

Attention à la référence : `runSecrets` grandit pendant le run (`runSecrets.push(...resolved.redact)`, `executor.ts:1579`). L'export de traces passe `[...secrets]` au moment de l'appel (`pi-runtime.ts:547`), donc voit les ajouts. Le recorder doit faire de même : garder la référence au tableau, pas une copie au démarrage.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `PiSessionStart` prend `secrets: string[]` (référence, pas copie) ; `pi-runtime.ts:305-312` la passe
- [ ] `appendMessage` rédige le message (texte, arguments d'outils, résultats) avec `redactSecrets` puis `redactSensitiveText`, comme `trace-export`
- [ ] `systemPrompt` rédigé à `start`
- [ ] Test : secret ajouté à `runSecrets` après `start` → absent d'un message enregistré ensuite
- [ ] `.env.example:66-68` complété d'une phrase : les secrets du run sont rédigés, le transcript reste en clair pour le reste
- [ ] Ne pas centraliser la rédaction dans `finish` : hors périmètre, noté ici pour ne pas y revenir
