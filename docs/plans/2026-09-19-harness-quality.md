# Harness quality — rapprocher l'expérience Rakazo de Grok Bot

> Analyse, pas d'implémentation. Objectif : qualité des réponses, usage du contexte, mémoire.
> Référence : Grok Bot (xAI × Cursor, beta 2026-08-11). Sources dans § 1.

## 0. TL;DR

> **Statut 2026-09-19 soir** : P0-3 et P1-1 livrés sur `main` local (non pushé). Prompts pi-agent-core copiés verbatim plutôt qu'importés (`generateSummary` exige registry pi-ai + `Model`, bypasserait `AgentRuntime`). Reste sur ces deux items : `cacheRetention:"none"` sur le résumé (champ manquant dans `AgentRunRequest`), estimation system prompt = constante 12k, `loadRunHistoryMessages` plafonne toujours à 200 lignes DB.

Rakazo a déjà les briques que Grok Bot n'a pas (mémoire inspectable, compaction locale, multi-canaux, self-host). Les écarts d'expérience sont dans **l'assemblage**, pas dans les briques :

| # | Écart | Levier | Effort |
|---|-------|--------|--------|
| P0-0 | **Bug** : `remember` *remplace* tout le document (`MemoryStore.commit` = full replace) alors que sa description dit « store a durable fact » → un appel avec un fait efface `MEMORY.md` | Sémantique append dans le handler `remember` ; l'ancien contenu ne survit que dans `MemoryRevision`, que rien n'affiche | 0.5 j |
| P0-1 | Cache prompt cassé à chaque tour (timestamp à la seconde en 2e position du system prompt, un seul bloc caché) | Déplacer le volatile (heure, mémoire, scratchpad) en fin de contexte ; `cacheRetention: "long"` | 0.5 j |
| P0-2 | Mémoire jamais alimentée sans appel explicite `remember` (Grok Bot : implicite) | Extraction de faits durables dans le job de compaction, écrite dans `MEMORY.md` via `memory.commit` | 1-2 j |
| P0-3 ✅ `aaec38cd` | Résumé de compaction = instruction d'une ligne, sans structure ni `previousSummary` exploité proprement | Réutiliser `generateSummary` / `SUMMARIZATION_SYSTEM_PROMPT` de pi-agent-core (Goal / Progress / Key Decisions / Next Steps / Critical Context) | 0.5-1 j |
| P0-4 | Historique **aplati** : tous les tours passés arrivent en `role:"user"`, les réponses du bot préfixées `Assistant: ` (`pi-runtime.ts:744-750`) → le modèle perd la structure des tours, relit ses réponses comme du texte utilisateur | Passer les vrais rôles à `Agent.initialState.messages` (`AgentMessage` accepte `assistant`) | 0.5 j |
| P1-0 | `maxTokens` défaut **4 096** (`domain.ts:947`) pour tout provider sauf override secret openai-compatible → livrables longs coupés | Défaut par provider (Anthropic/OpenAI 16k), garder le cap bas seulement pour OpenRouter | 0.25 j |
| P1-1 ✅ `ef33a7ef` | Fenêtre d'historique comptée en messages (50/200) alors que `message_user` fragmente une réponse en N messages | Fenêtre en tokens via `estimateTokens` / `findCutPoint` (pi-agent-core) | 1 j |
| P1-2 | Contexte mémoire : dump entier trié par `updatedAt` desc, cap 32 KiB silencieux, ordre instable | Épingler `MEMORY.md`, trier par path, cap par doc, signaler la troncature | 0.5 j |
| P1-3 | Runs canal (Slack/Telegram…) : **aucune** mémoire ni scratchpad injectés | Charger la mémoire bot en lecture seule sur les runs canal | 0.5 j |
| P1-3b | Runs routine : **zéro** historique de fil, zéro résumé, zéro recall (`threadContextForRun`) — Grok Bot fait tourner ses routines dans le fil du bot avec tout son contexte | Donner au run routine le résumé compacté + N derniers messages ; garder un flag pour les routines « stateless » | 0.5 j |
| P1-4 | Subagents sans persona, sans mémoire, sans skills | Passer `bot.instructions` + tranche mémoire au subagent | 0.5 j |
| P2-1 | Recall sémantique gated « après première compaction », query = prompt brut | Recall dès que provider configuré ; query = prompt + dernier tour | 0.5 j |
| P2-2 | Pas de contrôle utilisateur du contexte (« /compact », jauge) — Grok Bot non plus, et c'est la plainte #1 de ses users | Commande « oublie le fil » + jauge tokens dans l'UI | 1-2 j |

Recommandation : livrer P0 en un seul PR (≈3.5 j, voir § 5a), mesurer sur les bots réels, puis P1.

Cinq incohérences à corriger au passage (trouvées en lisant, pas de débat) :
- `executor.ts:3663` dit « Use remember for durable facts » même quand `selectMemoryTools` a retiré `remember` (provider sémantique configuré, `memory-tools.ts:9-11`).
- Provider configuré ⇒ le bot ne peut **plus écrire** la mémoire markdown, mais l'UI `KnowledgeSection` l'affiche et l'édite toujours.
- Compaction peut bloquer un fil : résumé > `MAX_COMPACTED_SUMMARY_CHARS` ⇒ curseur jamais avancé, même lot rejoué (`history-compaction.ts:324-328`) ; bootstrap d'un fil legacy > 40k chars ou un seul message > 40k ⇒ `skipped` pour toujours (`:231-250`). Le cas « lot > 40k » normal est sain : lot tronqué, curseur suit.
- Aucun tool call / tool result ne survit au run (`blocksToAgentHistoryText` ignore les blocs `steps`/`computer`, `attachments.ts:89-111`) : le bot ne peut pas relire ce qu'il a lu hier. Voulu pour la taille ; à revoir avec P0-3 (résumé structuré doit capturer fichiers lus/modifiés — `CompactionDetails.readFiles/modifiedFiles` de pi-agent-core fait exactement ça).
- Pas de garde de dépassement : `contextWindow` est plombé jusqu'à `AgentRunModel` mais jamais utilisé pour tailler le prompt ; un overflow remonte en erreur provider. Couvert par P1-1.
- `importMarkdown` force `scope: "user"` (`packages/memory/src/index.ts:136-141`) : un export bot ne revient pas en bot.
- Aucun chemin de suppression d'un `MemoryDocument` (ni tool, ni RPC, ni UI) ; `MemoryRevision` croît sans borne.

## 1. Grok Bot — ce qu'on cherche à égaler (et ce qu'on ne copie pas)

Légende : [C] source officielle · [R] review/forum · [I] inféré.

**Ce que les utilisateurs louent** [R] : finit le travail de bout en bout ; env persistant + agents nommés ; « first AI product I'd hand to someone who has never used one » ; handoff de fichiers entre bots.

**Mécanismes derrière l'expérience** :

- **Mémoire implicite, par bot** [C] : « A Bot can retain stable working preferences, important facts, and summaries from its work. » Aucune commande, aucune page d'édition ; correction conversationnelle. Règles durables → champ *description* du bot ; faits changeants → fichiers `/workspace` relus à chaque run.
- **Un thread par bot, non borné** [C] : résumé automatique « as we get close to the model's context limit » (staff Cursor, forum). Pas de reset, pas de compact manuel, pas de jauge → plainte #1 (« obsolete traffic stays in the model context forever »).
- **Modèle fixe, pas de picker** [C], failover automatique.
- **Progression visible sans narration** [C] : le transcript montre « tool activity, computer use, created files, questions, and approval requests alongside normal messages » ; vue *Agent Computer* séparée.
- **Persona = nom / titre / description / avatar** [C] ; la doc décourage le prompting « be brilliant, proactive » et pousse sources, conditions d'arrêt, autorité.
- **Format de livrable recommandé** [R] : Verified facts / Assumptions / Actions completed / Actions waiting for approval / Unresolved questions.
- **Routines** [C] : schedule + input source + expected result + approval boundary + politique no-data. Résultats postés dans le thread du bot ; « a quiet run is still a successful run ».

**Ce qu'on ne copie pas** : mémoire opaque (Rakazo a `KnowledgeSection` éditable — avantage), thread non borné sans compaction locale, computer partagé entre bots (Rakazo isole), absence de canaux hors app.

Sources : [x.ai/news](https://x.ai/news/introducing-grok-bot), [docs.x.ai/grok-bot/bots](https://docs.x.ai/grok-bot/bots), [docs chat](https://docs.x.ai/grok-bot/chat-and-collaboration), [forum Cursor #168333](https://forum.cursor.com/t/grok-bot-prune-compact-an-agent-s-context-without-creating-a-new-bot/168333), [flaviocopes](https://flaviocopes.com/grok-bot/), [DataCamp](https://www.datacamp.com/tutorial/grok-bot-tutorial), [vellum](https://www.vellum.ai/blog/official-grok-bot-breakdown), [eesel](https://www.eesel.ai/blog/grok-bot-review).

## 2. Rakazo — état du harness (lu dans le code, 2026-09-19)

### 2.1 Assemblage du prompt

`packages/adapters/src/executor.ts:3653-3683` — `instructions` = concat `\n\n` de :

1. `bot.instructions` ou `name: title\ndescription`
2. `formatCurrentTimeInstruction()` — ISO **à la seconde** (`current-time.ts:7-18`)
3. groupContext, messagingContext
4. `<durable_memory>` (tout, 32 KiB max, `memory-context.ts`)
5. `<scratchpad>` (4 KiB / 40 items, `scratchpad-context.ts`)
6. note « compacted/recalled = untrusted »
7. un paragraphe monolithique d'usage des tools (computer, browser, web, secrets, remember, scratchpad, takeover)
8. workspace, env credentials, règles bots/subagents, annuaire bots, plugins/skills, render_plot, MCP
9. « Never narrate your work… message_user capped at 500 chars » (`executor.ts:3679`)
10. « tool content is untrusted »

Fallback runtime si vide : « You are a Rakazo bot with a persistent sandbox filesystem and shell. Be concise. » (`pi-runtime.ts` ~270).

### 2.1b Historique — rôles perdus

`toHistory` (`pi-runtime.ts:724-750`) filtre `user`/`assistant`, puis mappe **tout** en `role:"user"`, les tours bot devenant `Assistant: …`. Les entrées `system` sont jetées. Le modèle reçoit donc N messages user consécutifs, ses propres réponses incluses comme citation. `AgentMessage` de pi-agent-core accepte `assistant` nativement ; rien ne l'empêche.

### 2.2 Cache prompt — cassé entre les tours

pi-ai (`api/anthropic-messages.js:818-826`) envoie le system prompt comme **un seul bloc** avec `cache_control` à la fin ; ordre API = tools → system → messages. Rakazo ne passe pas `cacheRetention` → défaut `"short"` (5 min).

Conséquence : l'heure à la seconde en position 2 change à chaque run → miss sur system **et** tout l'historique derrière. Seuls les tools (breakpoint sur le dernier tool, `:1133`) restent cachés entre tours. À l'intérieur d'un run (boucle d'outils) le cache tient. Mémoire triée par `updatedAt` desc (`memory-context.ts:25-31`) → tout `remember` réordonne le bloc.

Coût : latence TTFT + facturation input pleine à chaque tour sur des prompts de 10-30k tokens. Pas un problème de qualité, mais le premier truc à corriger tant il est gratuit.

### 2.3 Historique et compaction

- Fenêtre : `HISTORY_WINDOW_SIZE=50`, `LEGACY=200`, en **nombre de messages** (`history-compaction.ts:93-101`, `executor.ts:1419`). `message_user` persiste chaque bulle comme un `Message` (`executor.ts:1645`) → une réponse « humaine » de 5 bulles = 5 slots. 50 messages ≈ 10 tours réels.
- Compaction locale : job `historyCompactJob` par lots de 50 (`COMPACTION_BATCH_SIZE`), résumé unique remplacé (`MAX_COMPACTED_SUMMARY_CHARS=20_000`), stocké sur `Thread.historyCompactionSummary`. Quand un résumé existe, l'historique = tous les messages depuis `historyCompactedUpToSeq` (contigus) — donc 0 à ~50+ messages, sans slice.
- Summarizer : même runtime, instruction d'une ligne (« Produce a complete replacement summary… preserving important facts, decisions, unresolved work, and user preferences… output only the concise, factual summary »). Pas de structure, pas de section « next steps / open questions », pas de lien vers les fichiers touchés.
- pi-agent-core 0.85.1 expose déjà `generateSummary(currentMessages, …, previousSummary, …)`, `SUMMARIZATION_SYSTEM_PROMPT` (structuré Goal / Progress / Key Decisions / Next Steps / Critical Context), `estimateTokens`, `findCutPoint`, `DEFAULT_COMPACTION_SETTINGS {reserveTokens: 16384, keepRecentTokens: 20000}` — **non utilisés** (cohérent avec le verdict Opus de ce soir : câbler les built-ins Pi avant tout multi-harness).

### 2.4 Mémoire

Trois couches, pas reliées entre elles. Pas d'embeddings ni de vector search dans le repo : `MarkdownMemoryStore.search` est un `includes()` avec `score: 1` (`packages/memory/src/index.ts:49-69`) ; Serenity renvoie aussi `score: 1` ; seul Supermemory a une similarité réelle.

| Couche | Écriture | Lecture | Fichiers |
|--------|----------|---------|----------|
| `MarkdownMemoryStore` (Prisma `MemoryDocument`/`MemoryRevision`, scopes bot/user) | tool `remember` uniquement (`executor.ts:2618`) | dump entier dans le system prompt | `packages/memory/src/index.ts`, `memory-context.ts` |
| Provider sémantique optionnel (Serenity / Supermemory) | `save_memory` + résumé de compaction (scope isolated) | `recall_memory` + auto-recall **seulement si thread déjà compacté**, query = prompt brut, top 5, injecté en message user `<recalled_memory>` | `memory-provider-factory.ts`, `memory-tools.ts` |
| Scratchpad (`ScratchpadItem`) | `scratchpad_add/update/complete` | bloc system 4 KiB | `scratchpad-context.ts` |

Constats :

- **`remember` détruit.** `commit` remplace `content` entier (`packages/memory/src/index.ts:86-92`) ; la description du tool (`builtin-tools.ts:409`) et son schéma (`content: string`) promettent « store a fact ». Le modèle voit `MEMORY.md` dans son system prompt, appelle `remember("Romain préfère le français")` → `MEMORY.md` = cette ligne. Explique probablement des pertes de mémoire observées comme « le bot oublie ».
- **Routines amnésiques.** `threadContextForRun` (`executor.ts:4561-4581`) : trigger `routine` ⇒ `messages: []`, `summary: null`, pas de recall. Le run reçoit seulement le dump mémoire + scratchpad + workspace. Une routine quotidienne ne sait pas ce que le bot a dit hier dans le même fil.
- **Rien n'apprend tout seul.** Le seul signal est « Use remember for durable facts » noyé dans le paragraphe tools. Grok Bot retient préférences et faits sans qu'on le demande. C'est l'écart d'expérience le plus visible pour un utilisateur.
- Runs canal (`isMessagingChannelRun`, `executor.ts:1395-1403`) : mémoire et scratchpad **non chargés**. Un bot Slack ne connaît pas ce qu'il sait sur le web.
- Cap 32 KiB : les docs les plus anciens tombent en silence ; `MEMORY.md` peut être évincé par un doc récent.
- Le résumé de compaction part vers le provider sémantique mais jamais vers `MemoryDocument` → sans Serenity/Supermemory, la connaissance extraite des conversations n'existe pas.
- Subagents (`pi-runtime.ts:1104-1111`) : system prompt de 3 phrases, pas de persona, pas de mémoire, pas de skills, images pruned seulement.

### 2.5 Réponses et progression

- `message_user` : 500 chars, « Never narrate », découpage en bulles courtes. Choix produit défendable (Grok Bot ne narre pas non plus).
- Progression : blocs `steps` (`AgentSteps`) et `progress` rendus dans `message-view.tsx:194-281` ; le bot « glance around » pendant le travail (commits de ce soir). Donc l'équivalent du transcript Grok Bot existe. À vérifier en usage : lisibilité des steps sur un run long (>30 tool calls) et sur mobile.
- Tool results clippés à 12 000 chars **tête seule** (`pi-runtime-limits.ts:10-12`) → une commande dont l'erreur est en fin de sortie perd l'erreur.
- Aucun guidage de format de livrable (Grok Bot recommande Verified facts / Assumptions / Actions / Waiting approval / Open questions).

## 3. Recommandations

Contraintes : AGENTS.md (provider-neutral, pas d'abstraction spéculative, CHANGELOG si visible), diffs minimaux.

### P0 — un PR, ~3.5 jours

**P0-0 `remember` en append.**
- Handler `executor.ts:2618` : lire le doc existant (`deps.memory.read`), écrire `existing + "\n" + content` (ou `content` seul si nouveau). Le tool devient ce que sa description promet. Une révision par appel reste tracée.
- Option `replace: boolean` seulement si un bot réel a besoin de réécrire (`// ponytail: append-only ; replace via l'UI KnowledgeSection`).
- Retirer la phrase « Use remember for durable facts » quand le tool n'est pas exposé (`executor.ts:3663` ⇒ conditionner sur `selectMemoryTools`).

**P0-4 Rôles réels dans l'historique.**
- `toHistory` (`pi-runtime.ts:724-750`) : `m.role === "assistant"` → `{ role: "assistant", content: [{ type: "text", text }] }` au format `AgentMessage` au lieu du préfixe `Assistant: `. Garder `withoutSteeringMessages` et la dédup du prompt. Introduit dans `a7bf86a3` (« Boot a real Pi computer »), probablement un raccourci de bootstrap, pas un choix.
- Effet attendu : fin des réponses qui « répondent à elles-mêmes », meilleure continuité de ton, et cache prompt plus stable (préfixes stables).

**P0-1 Cache prompt stable.**
- Sortir du system prompt ce qui change à chaque run : heure, `<durable_memory>`, `<scratchpad>`. Les préfixer au **prompt de tâche** (dernier message user), là où sont déjà `<recalled_memory>` et le résumé compacté. System = persona + règles tools + workspace + skills → stable → caché.
- Trier la mémoire par `scope, path` (pas `updatedAt`).
- Passer `cacheRetention: "long"` dans `reliableStreamOptions` (`pi-runtime.ts:1764`) : 1 h de TTL colle au rythme d'un chat, 5 min non. Neutre pour les providers non-Anthropic.
- Mesure : `cacheRead` déjà remonté dans `cost` (`pi-runtime.ts:533`) → comparer avant/après sur un bot réel.

**P0-2 Mémoire implicite.**
- Dans `history-compaction.ts`, après le résumé, second appel court : « Liste les faits durables nouveaux (préférences utilisateur, décisions, identifiants de ressources, corrections) absents de la mémoire actuelle. Sortie : puces markdown ou vide. » Entrée = transcript du lot + contenu actuel de `MEMORY.md`.
- Écrire via `deps.memory.commit({scope:"bot", path:"MEMORY.md"})` en append sous `## Learned YYYY-MM-DD` ; révision tracée (`MemoryRevision`), donc visible et éditable dans `KnowledgeSection` — c'est l'avantage sur Grok Bot, le garder.
- Garde-fous : max 10 puces par lot, pas de secrets (`redactSecrets`), pas d'écriture si sortie vide. Pas de dédup sémantique en v1 (`// ponytail: append-only, dedupe when MEMORY.md dépasse 8 KiB`).
- Renforcer la consigne dans le system prompt d'une phrase : quand l'utilisateur exprime une préférence, une correction ou un fait stable → `remember` immédiatement.

**P0-3 Résumé structuré.**
- Remplacer l'instruction d'une ligne par `SUMMARIZATION_SYSTEM_PROMPT` de pi-agent-core, ou appeler `generateSummary(...)` avec `previousSummary`. Sections Goal / Progress / Key Decisions / Next Steps / Critical Context donnent au bot un « où j'en suis » après compaction — ce qui rapproche du « keeps a role over time » de Grok Bot.
- Garder `MAX_COMPACTED_SUMMARY_CHARS`, `historyCompactionGeneration` tel quel. Diff contenu dans `history-compaction.ts`.
- Anti-blocage : dire au summarizer la longueur max (« under 4 000 words ») et, si le résumé dépasse quand même le cap, tronquer + avancer le curseur plutôt que logger une erreur et rejouer le même lot.

### P1 — après mesure

**P1-1 Fenêtre en tokens.** Remplacer `slice(-N messages)` par un cut sur budget (`estimateTokens` de pi-agent-core, ~`keepRecentTokens` 20k) et déclencher la compaction sur budget plutôt que sur lot de 50. Un tour ne doit jamais être coupé au milieu (`findTurnStartIndex`).

**P1-2 Contexte mémoire robuste.** `MEMORY.md` toujours en premier ; cap par document (8 KiB) ; ligne finale « N documents omitted, use recall/… » quand tronqué.

**P1-3 Mémoire sur runs canal.** Charger `loadAgentMemoryContext` aussi quand `messagingChannelRun` (lecture seule ; l'écriture reste interdite si c'est un choix sécurité — vérifier la raison du skip avec `git log -S messagingChannelRun`).

**P1-3b Routines avec contexte.** `threadContextForRun` : pour `routine`, garder `summary` + `historyCompactedUpToSeq` et les 20 derniers messages ; `includeSemanticRecall: true`. Si la raison du blank slate était le coût ou la reproductibilité, l'exposer comme option de la routine (`stateless`), défaut = avec contexte, comme Grok Bot.

**P1-4 Subagents contextualisés.** Ajouter `bot.instructions` (persona) et la partie `MEMORY.md` au system prompt du subagent (`pi-runtime.ts:1104`). Pas les skills en v1.

**P1-5 Clip tête+queue.** `clipToolResultText` : garder 9k tête + 3k queue avec marqueur `[… N chars omitted …]`. Trois lignes.

**P1-6 Format de livrable.** Une phrase dans le system prompt pour les runs longs / routines : terminer par Faits vérifiés / Hypothèses / Fait / En attente d'approbation / Questions ouvertes. Optionnel, à tester sur 2-3 bots.

### P2 — différenciation

**P2-1 Recall toujours actif** quand un provider est configuré (pas gated sur compaction) ; query = prompt + dernier échange.
**P2-2 Contrôle utilisateur du contexte** : action « repartir de zéro sur ce fil » (nouvelle génération de compaction, historique vidé, mémoire conservée) + jauge tokens du dernier run dans le panneau bot. C'est la demande #1 des utilisateurs Grok Bot, non satisfaite chez eux.
**P2-3 Mémoire utilisateur transverse** : le scope `user` existe déjà dans le store et est lu (`memory-context.ts:17`) ; l'extraction P0-2 pourrait router les préférences personnelles vers `scope:"user"` pour qu'elles suivent l'utilisateur d'un bot à l'autre. Grok Bot ne le fait pas.

## 4. Ce qu'on ne fait pas

- Pas de multi-harness / Claude Code dans le computer (verdict Opus 2026-09-19 : non justifié).
- Pas de nouveau provider mémoire ; pas d'embeddings maison. Le store markdown + provider optionnel suffit.
- Pas de changement du choix « pas de narration » : Grok Bot fait pareil ; la progression passe par les blocs `steps`.

## 5. Mesure

Avant/après P0 sur 2 bots réels pendant une semaine :
- `cacheRead / (input)` par run (déjà dans `cost`).
- Nombre de révisions `MEMORY.md` créées sans appel explicite `remember`.
- Lecture manuelle de 5 résumés de compaction : le bot sait-il « où il en est » ?
- Latence TTFT médiane par tour.

## 5a. Ce que Pi fournit déjà (survey écosystème, 2026-09-19)

Upstream = `earendil-works/pi` (MIT, très actif). Vérifié dans `pi-agent-core@0.85.1` installé.

| Besoin | Déjà là | Comment | Verdict |
|---|---|---|---|
| Compaction budget tokens (P1-1) | `shouldCompact(tokens, contextWindow, settings)`, `estimateContextTokens` (réutilise l'`usage` provider du dernier tour), `findCutPoint` (ne coupe jamais un toolCall de son toolResult), `DEFAULT_COMPACTION_SETTINGS` | exportés de `@earendil-works/pi-agent-core`, déjà dans `node_modules` | **importer** |
| Résumé structuré + merge (P0-3) | `generateSummary(messages, models, model, reserveTokens, customInstructions, previousSummary, …)` — prompt Goal / Constraints / Progress (Done/In Progress/Blocked) / Key Decisions / Next Steps / Critical Context **interne**, variante UPDATE quand `previousSummary` fourni | exporté ; `SUMMARIZATION_SYSTEM_PROMPT` visible dans `dist/harness/compaction/compaction.d.ts:75` mais pas ré-exporté (copier 3 lignes si besoin) | **importer** |
| Résumé dans l'historique sans faux tour user | `createCompactionSummaryMessage(summary, tokensBefore, ts)`, `COMPACTION_SUMMARY_PREFIX`, rôle `compactionSummary` | `dist/harness/messages.d.ts:48` | **importer** — remplace `formatCompactedSummary` en user-role |
| Rôles réels (P0-4) | `AgentMessage` = `UserMessage \| AssistantMessage \| ToolResultMessage \| compactionSummary \| custom` ; `ToolCall` vit dans `AssistantMessage.content` | `pi-ai/dist/types.d.ts:256-347` | **importer** les shapes |
| Replay session complète (tool results compris) | `StorageBackedSession` sur `JsonlSessionRepo` (déjà importé dans `pi-session.ts`) + pattern `buildSessionContext`/`sessionEntryToContextMessages` de pi-coding-agent `session-manager.ts` | export `./harness/session` | **copier pattern** — v2, remplace le re-feed texte |
| Placement de la compaction | pi-coding-agent la fait dans `prepareNextTurnWithContext` (que Rakazo utilise déjà pour le steering, `pi-runtime.ts:304-333`), pas à l'entrée du prompt | `coding-agent/src/core/agent-session.ts` | **copier pattern** |
| Ordre system prompt cache-friendly (P0-1) | pi-coding-agent : `preamble → tools → rules → docs → addendum → project_context → skills → cwd`, sections `<name>…</name>`, **aucune date** dans le system prompt ; `cacheRetention:"none"` sur les appels de résumé | `coding-agent/src/core/system-prompt.ts` ; `diffSystemPromptSections` existe sur `main` mais `Context.sections` absent de 0.85.1 | **copier l'ordre** ; pas de bump pour le diff |
| Mémoire implicite (P0-2) | Rien. Lecture = pattern `loadContextFileFromDir` (AGENTS.md/CLAUDE.md) ; écriture = hook `session_before_compact` + `CompactionDetails.readFiles/modifiedFiles`. Extensions communautaires toutes DB/embeddings (`pi-hermes-memory` 446★ SQLite, prior art pour l'auto-consolidation) ou curées à la main | — | **construire** (~50 lignes entre les deux moitiés) |
| Subagents (P1-4) | Core exclut volontairement. `pi-subagents` 3.6k★ actif, mais API extension pi-coding-agent (`pi.on`, `pi.registerTool`) que Rakazo n'a pas | github.com/nicobailon/pi-subagents | **copier pattern** |
| Routines / teammate persistant | Rien en core. `pi-mom` (Slack + `croner`) obsolète, ancien scope `@mariozechner`. `@earendil-works/pi-durable` 0.85.1 vise exactement ça, API publique = 2 symboles | — | **surveiller** pi-durable |

Sur `cacheRetention` : upstream n'utilise jamais `"long"`. Pour un coding agent en boucle serrée, 5 min suffisent. Pour Rakazo, les tours humains sont espacés de 10-60 min → `"long"` (1 h) reste justifié malgré l'écriture cache 2× vs 1.25×. Décision à valider par la mesure `cacheRead` (§5), pas par principe. `"none"` sur le job de compaction dans tous les cas.

Conséquence sur les efforts : P0-3 tombe à 0.5 j (appel de `generateSummary` + `createCompactionSummaryMessage`), P1-1 à 0.5 j (`shouldCompact` + `findCutPoint`), P0-4 inchangé. Total P0 ≈ 3.5 j.

## 5b. Note sur une fausse piste

Un grep `cache_control|anthropic-beta` sur `packages/` + `apps/` rend zéro hit : ça ne veut pas dire « pas de cache ». pi-ai pose les `cache_control` lui-même (`api/anthropic-messages.js:818-826, 1067-1082, 1133`). Le problème est le **miss** (timestamp + tri mémoire), pas l'absence. Mesurer `cacheRead` dans `cost` (`pi-runtime.ts:533`) avant/après P0-1, ne pas ajouter de header.

`temperature`/`topP` jamais fixés : défauts provider, aucun changement proposé.

## 6. Ouvert

- Blank slate des routines = PR #388 « fix(adapters): isolate scheduled routine context » (deux commits : isolate thread context, hide memory recall). Aucun motif dans le message. Demander à l'auteur avant P1-3b ; hypothèse : éviter qu'une routine rejoue une conversation humaine hors sujet. Skip mémoire canal = PR #700 « keep private context out of group replies » — motif clair (fuite privée en groupe) ⇒ P1-3 doit rester lecture seule et exclure le scope `user`.
- `HISTORY_WINDOW_SIZE=50` n'est actif qu'avec provider sémantique + fil compacté + recall réussi ; sinon 200. La fenêtre courte compense un recall présent. P1-1 (budget tokens) rend la distinction inutile.
- Multi-utilisateur : `@@unique([spaceId, scope, botId, path])` sans `userId` (`schema.prisma:850`) alors que les lectures filtrent sur `userId` → collision sur `scope:"user"` dans un space partagé. Hors périmètre expérience, à noter pour upstream.
