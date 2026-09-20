# Cadrage — observabilité LLM optionnelle (Langfuse)

**Statut** : cadrage, pas d'implémentation. Aucune ligne de code de ce document n'est écrite.
**Branche de référence** : `feat/harness-context-quality`. Première passe sur la branche avant le ticket 13 ; **deuxième passe** au merge du ticket 13 (`6d2a85d5`, commits `1a0f8a44` et `cd9e8563`).
**Question posée** : brancher le SDK Langfuse pour tracer les runs d'agent (run, tours, appels d'outils, compaction). Si une brique existe déjà, partir d'elle.

> **Lecture du delta** : tout ce qui a changé entre les deux passes est marqué **[MAJ 2e passe]** dans le corps du texte, et résumé dans la section « Delta » juste sous le TL;DR. Le reste tient tel quel.

---

## TL;DR

- **Langfuse et OpenTelemetry n'existent pas dans le code du dépôt.** Aucun import, aucune variable d'environnement, aucune mention dans `docs/`. OTel n'apparaît que transitivement dans le lockfile via `@daytona/sdk` et comme peer optionnel de `better-auth` ; le code Rakazo ne l'importe nulle part.
- **Mais 80 % des briques sont là** : un pipeline de logs structurés avec sinks optionnels, garde-fous et redaction (`@rakazo/logging`), un exporteur externe optionnel qui est exactement le pattern à copier (Axiom), un `traceId` stable par run dans `AdapterContext`, un enregistreur de transcript JSONL opt-in par run, et deux logs de fin de run (`agent.run.context`, `agent.run.usage`) plus une table `UsageRecord`.
- **Pour les tickets 08 et 09, le log suffit.** `agent.run.context` porte déjà tous les compteurs demandés. Ce qui manque n'est pas Langfuse, c'est une destination d'agrégation (Axiom activé ou extraction des logs conteneur), et c'est déjà noté comme prérequis dans les deux tickets.
- **Ce que Langfuse apporterait vraiment** : une vue arborescente run → tour → outil avec latences, et, en mode contenu, la relecture des prompts et réponses. Le premier point n'existe pas aujourd'hui (aucune latence par tour ni par outil dans les logs). Le second existe déjà en local via `PI_SESSION_RECORDING`, sans tiers.
- **Le point dur est la frontière de données**, pas l'intégration. Trois décisions sont laissées au mainteneur (§ 3 et § 8).
- **[MAJ 2e passe]** Le ticket 13 ne change ni le verdict ni le découpage. `historyTokensByRole` mesure ce qui **entre** dans le run (composition de l'historique, par rôle exécuteur) ; L1 mesure ce qui **se passe pendant** le run (latence et tokens réels par tour, coût de la compaction). Les deux ne se recouvrent pas. L1 reste entier.

---

## Delta — deuxième passe (ticket 13) **[MAJ 2e passe]**

Ce qui a atterri, lu dans le diff `6d2a85d5^1..6d2a85d5` (6 fichiers, `history-compaction.ts` non touché) :

| Changement | Où | Effet sur ce cadrage |
|---|---|---|
| `toHistory` renvoie `AgentMessage[]` ; les tours passés du bot repartent comme `assistant` natifs (`api`/`provider`/`model` du modèle résolu du run, `usage` mis à zéro par `noUsage()`, `stopReason: "stop"`) ; **le tour le plus ancien reste en rendu utilisateur marqué** (`index > 0`) | `packages/adapters/src/pi-runtime.ts:747-757` (`noUsage`), `:771-818` (`toHistory`), `:796-806` (branche native) | Un usage à zéro entre dans l'état initial de l'agent et dans le transcript JSONL. Analysé au § 5.4 : **aucun effet sur `agent.run.usage` / `UsageRecord`**, un piège pour un exporteur de contenu |
| `agent.run.context` gagne `historyTokensByRole` (reduce sur `runtimeHistory`, clé = rôle côté exécuteur, `estimateTextTokens`) | `packages/adapters/src/executor.ts:3761-3769` (calcul), `:3784` (champ) | Nouveau compteur d'entrée. Ne recouvre pas L1 (§ 5.3). Renforce la position « pas de tiers » |
| Les lignes `system` (apartés de thread) sont filtrées en un seul endroit, après `selectCompactedHistory` ; `messageToAgentHistoryTurn` garde le rôle `"system"` | `executor.ts:1414-1427`, `packages/adapters/src/reply-context.ts:85-88` | Conséquence pour la mesure : `historyTokensByRole` n'a jamais de clé `system`, seulement `user` et `assistant` |
| Test de bout en bout des apartés | `packages/adapters/src/executor-compaction-asides.test.ts` | Aucun |
| Entrée CHANGELOG « Replayed turns are counted as costing nothing » | `CHANGELOG.md` | Confirme l'intention : le zéro est voulu, pas un oubli |

Verdict par question :

| Question | Réponse courte | Détail |
|---|---|---|
| L1 rétrécit ? | **Non. L1 inchangé.** | `historyTokensByRole` est une estimation statique de l'entrée ; L1 est la latence et l'usage réel par tour + le coût de la compaction. Zéro recouvrement. Une ligne restée : le log de tour de L1 ne doit rien redire de la composition de l'historique, c'est désormais dans `agent.run.context` |
| La réserve « rôle exécuteur ≠ forme sur le fil » tient ? | **Oui, mais bornée à un message par run.** Proxy suffisant pour la répartition des tokens ; insuffisant pour compter native vs repli | § 5.3 |
| L'usage à zéro fausse le coût ? | **Non pour `UsageRecord`/`agent.run.usage`. Oui pour un exporteur qui lirait `initialMessages`.** | § 5.4 |
| Nouvelle mesure à capturer ? | Un booléen « l'historique s'ouvre sur un tour assistant », optionnel, une ligne dans `agent.run.context`, pas de ticket | § 5.3 |
| Les trois décisions bougent ? | 1 et 2 : non. 3 : **renforcée** vers « L1 seul peut suffire » | § 8 |

Lignes réajustées dans tout le document (le ticket 13 décale `executor.ts` de +6 avant `agent.run.context` puis +16 après, et `pi-runtime.ts` de +1 à +3 avant `toHistory` puis +34 à +38 après). Chaque référence ci-dessous a été relue au commit `6d2a85d5`.

---

## 1. Ce qui existe vs ce qui manque

### 1.1 Existant, vérifié

| Brique | Où | Ce qu'elle fait | Réutilisable pour |
|---|---|---|---|
| Interface `LogSink` | `packages/logging/src/types.ts` | `write(event): void \| Promise<void>`, `flush?()` | Modèle d'interface neutre côté opérateur |
| Garde-fous sink | `packages/logging/src/sink-guard.ts` | `guardedWrite` (try/catch + `.catch` sur promesses), `guardedFlush`, `reportSinkError` limité à une remontée par fenêtre de 30 s avec compteur de suppressions | Le « jamais faire échouer le run » demandé au § 4 est déjà écrit |
| Flush borné | `packages/logging/src/logger.ts` | `flush()` court-circuite les sinks après 2 000 ms | Arrêt propre sans bloquer sur un exporteur muet |
| Redaction | `packages/logging/src/redaction.ts` | `redactBindings` (clés `email`, `prompt`, `message`, `messages`, `body`, `query`, `headers`, `passwd`, `api_key`, regex secrets) ; `redactSensitiveText` (emails, Bearer, `sk-…`, JWT, `ak_`/`ck_`) | Toute donnée passant par le logger est déjà expurgée ; **cela rend le mode contenu impossible via le logger**, ce qui est un fait structurant (§ 3) |
| Exporteur externe optionnel | `packages/logging/src/axiom.ts:44-72` | `createAxiomSinkFromEnv` : les deux variables requises, sinon `{}` ; config partielle → warning unique `Axiom logging is disabled; AXIOM_TOKEN and AXIOM_DATASET must both be set.` ; `createRootLogger` (74-84) installe le sink au point de composition | **Le pattern à copier trait pour trait** (env, partiel, no-op, composition root, test offline avec client injecté `packages/logging/src/axiom.test.ts`) |
| Variables compose optionnelles | `infra/compose/docker-compose.prod.yml:213-218`, `infra/compose/docker-compose.yml:56-61` | `LOG_LEVEL`, `LOG_FORMAT`, `AXIOM_*` en `${VAR:-}` | Même forme pour les futures variables |
| Doc self-host | `docs/self-host.md:162-171` | Section « Logging » : Axiom optionnel, « A partial Axiom config logs a one-time warning and stays off » | Ajouter une sous-section, pas une page |
| Identifiant de trace par run | `packages/adapter-kit/src/types.ts:3-19` (`AdapterContext.traceId`), `packages/adapters/src/executor.ts:1319-1327` (`traceId: runId`) | Un run d'agent a un `traceId` égal à son `runId` | Clé de corrélation naturelle d'une trace Langfuse |
| Corrélation job | `packages/adapters/src/wakeup.ts:106`, `packages/logging/src/jobs.ts` | `runCorrelatedJob` pose `trace.id`, `span.id`, `job.id`, `run.id`, `bot.id`, `thread.id`, `space.id`, `user.id` dans le contexte AsyncLocalStorage ; `job.completed` avec `job.duration_ms` | Toute ligne de log émise pendant un run porte déjà ces ids |
| Transcript par run (opt-in) | `packages/adapters/src/pi-session.ts:32-34, 127-146, 153-243` | `PI_SESSION_RECORDING=true` ; `PiSessionRecorder.start(PiSessionStart)` → `PiSessionHandle.appendMessage` ; entrée `rakazo_context` (systemPrompt inclus) puis chaque message de `initialMessages` (`:202-204`) ; `BestEffortPiSession` avale les erreurs et logue une fois ; rétention 30 jours / 100 fichiers par bot | **C'est déjà un « content tracer » local.** Un exporteur Langfuse en mode contenu n'est qu'une seconde implémentation de `PiSessionRecorder`. **[MAJ 2e passe]** Depuis le ticket 13, `initialMessages` contient des tours `assistant` natifs à usage zéro (§ 5.4) |
| Branchement du recorder | `packages/adapters/src/pi-runtime.ts:164-176, 285-305, 357-359` **[MAJ 2e passe : lignes]** | Construit uniquement si `sessionRoot` fourni ; démarré si `context.userId` ; `initialMessages: history` (`:297`) ; `message_end` → `appendMessage` | Point d'injection existant |
| Compteurs de contexte | `packages/adapters/src/executor.ts:3772-3788` **[MAJ 2e passe : lignes]** | `agent.run.context`, « Counters only, never content » : `historyWindowMode`, `contextWindow`, `toolSchemaTokens`, `toolCount`, `historyTokens`, **`historyTokensByRole`** (`:3784`, nouveau), `historyMessagesKept` / `Available`, etc. | **Répond aux tickets 08/09 tel quel** |
| Usage par run | `packages/adapters/src/executor.ts:4231-4258` **[MAJ 2e passe : lignes]** | log `agent.run.usage` + `prisma.usageRecord.create` (provider, model, inputTokens, outputTokens) | Coût par run déjà persisté |
| Audit outil persistant | `packages/adapters/src/executor.ts:614-680, 3832-3843` **[MAJ 2e passe : lignes]** | `agent.tool.completed` dans la table `Event` : nom, `executionId`, `durationMs`, outcome, erreur assainie, types de contenu | **La durée par appel d'outil existe déjà, en base, pas en log** |
| Durée outil mesurée | `packages/adapters/src/pi-runtime.ts:1082-1093` **[MAJ 2e passe : lignes]** | `AgentToolCompletion.durationMs = Date.now() - startedAt` dans le `finally`, `onToolCompleted` best-effort | Source unique de la latence outil |
| Redaction des secrets de run | `packages/core/src/events.ts:366-371` | `redactSecrets(value, secrets)` remplace chaque secret injecté par `[redacted]` | Première passe obligatoire avant toute sortie de contenu |
| Persistance runs | `packages/db/prisma/schema.prisma:562` (`Run`), `:987` (`UsageRecord`), `:523` (`Event`), `:497` (`Message`) | `Run.startedAt/completedAt/status/modelProvider/modelId/error` | Durée totale d'un run déjà déductible sans tracing |

### 1.2 Manquant, vérifié

| Manque | Preuve | Gravité pour ce cadrage |
|---|---|---|
| Aucune latence par tour LLM | `pi-runtime.ts:387-416` traite `turn_end` sans horodatage ; aucun log `agent.turn.*` **[MAJ 2e passe : lignes ; inchangé sur le fond]** | C'est le seul apport « dur » d'un traceur par rapport à l'existant |
| Usage de la compaction jeté | `packages/adapters/src/history-compaction.ts:550-558` ne consomme que `text` et `done` ; l'événement `usage` (émis par `pi-runtime.ts:423-431`) est ignoré ; pas de `usageRecord`. **[MAJ 2e passe]** Fichier non touché par le ticket 13, lignes vérifiées | Le coût réel de la compaction est invisible partout, Langfuse ou pas |
| `UsageRecord` sans cache tokens | `schema.prisma:987` : `inputTokens`, `outputTokens` seulement ; l'événement `usage` porte `cacheReadTokens?`/`cacheWriteTokens?` (`adapter-kit/src/types.ts:439-448`) | Indépendant de Langfuse ; hors périmètre ici |
| Deux identifiants de trace coexistent | `AdapterContext.traceId = runId` (`executor.ts:1319-1327`) vs `trace.id` W3C 32 hex posé par `runCorrelatedJob` (`packages/logging/src/ids.ts`, `jobs.ts`) | Choisir la clé Langfuse : `runId` est le bon candidat (stable, lisible, déjà en base) ; l'id W3C sert aux logs |
| `PI_SESSION_RECORDING` non documenté | Aucune mention dans `docs/` (`rg` sur `docs`) | Si on ajoute un exporteur de contenu, documenter les deux ensemble |
| Langfuse / OTel | Aucun import dans `apps/`, `packages/` ; aucune variable dans `infra/compose/` | Tout est à écrire, mais petit |
| **[MAJ 2e passe]** Native vs repli non compté | `toHistory` décide le rendu (`pi-runtime.ts:796-806`) sans rien émettre ; `historyTokensByRole` compte par rôle exécuteur, pas par forme émise | Faible : le repli concerne au plus un message par run (§ 5.3) |

**Constat de dimensionnement** : l'intégration elle-même tient dans un fichier d'interface, un fichier d'implémentation, deux lignes de composition root et une poignée de hooks. Le vrai travail est la décision de frontière de données et sa documentation.

---

## 2. Points d'accroche (spans)

Hiérarchie proposée : **trace = run d'agent** (`runId`) → **generation = un tour LLM** → **span = un appel d'outil**. La compaction est **une trace à part** (son `runId` est `compact:<threadId>:<seq>`).

| Niveau | Début | Fin | Données sans contenu disponibles | Ligne **[MAJ 2e passe : toutes relues]** |
|---|---|---|---|---|
| Trace run | `deps.runtime.run({...}, context)` | sortie de `for await (const event of withRuntimeCleanup(...))` | `runId`, `botId`, `spaceId`, `userId`, `threadId`, provider/model, `historyWindowMode`, `contextWindow`, `toolSchemaTokens`, `toolCount`, `historyTokensByRole`, statut final, erreur assainie | `executor.ts:3789-3902` (appel), `:3903` (boucle), `:3772-3788` (compteurs) |
| Generation (tour) | premier `message_update` ou début de `agent.prompt` | `message_end` avec `usage` | tokens in/out/cache, provider, model, `stopReason` si exposé par Pi, durée | `pi-runtime.ts:356` (`subscribe`), `:357-359` (`message_end`), `:423-431` (usage), `:387-416` (`turn_end`) |
| Span outil | `tool_execution_start` | `finally` de l'exécution | `name`, `executionId`, `durationMs`, outcome, `paused`, types de contenu du résultat | `pi-runtime.ts:360-371`, `:1082-1093` ; côté executor `:4080` (`event.type === "tool"`), `:3832-3843` (`onToolCompleted`) |
| Trace compaction | `deps.runtime.run({ runId: \`compact:${threadId}:${fromSeqExclusive}\`, ... })` | `done` | `threadId`, generation, `fromSeqExclusive`, modèle, `maxTokens`, tokens (**à condition de consommer l'événement `usage`**, cf. § 1.2) | `history-compaction.ts:525-549`, `:550-558` |
| Sous-agents | événement `subagent` | `status: completed/failed` | `agentId`, `name`, statut | `adapter-kit/src/types.ts:450-458`, usage imbriqué `pi-runtime.ts:1223-1231` **[MAJ 2e passe : vérifié, plus une approximation]** |

**Constat** : les trois premiers niveaux passent tous par `pi-runtime.ts` (souscription `agent.subscribe`) et `executor.ts` (boucle d'événements). Deux fichiers, déjà porteurs de `getLogger()` et du `sessionRecorder`. Aucun nouveau point de passage à créer.

**[MAJ 2e passe] Règle de contrat pour toute implémentation** : une generation naît d'un `message_end` **pendant** `agent.prompt`, jamais de `initialState.messages`. Les messages rejoués (`toHistory`) ne sont pas des tours du run ; ils sont l'entrée de la trace. Raison au § 5.4.

**Où poser l'interface** : `PiAgentRuntimeOptions` (`pi-runtime.ts:164-167`) reçoit déjà `sessionRoot?` pour le recorder. Ajouter un second champ optionnel de type neutre (un « recorder de trace ») au même endroit est le geste minimal ; le worker (`apps/worker/src/index.ts:81-84`) et l'API (`apps/api/src/app.ts:303-308`) le remplissent ou non à la composition. Aucun import Langfuse hors de ces deux fichiers et de l'implémentation dédiée.

---

## 3. Frontière de données — le point dur

Inchangé sur le fond par le ticket 13. Une caveat s'ajoute au mode C (§ 3.1, dernière ligne).

### 3.1 Ce qui sortirait, par mode

| Mode | Sort vers le tiers | Ne sort pas | Coût de mise en œuvre | Risque |
|---|---|---|---|---|
| **A — métriques seules** | ids (`runId`, `botId`, `spaceId`, `threadId`, `userId` sous forme d'id opaque), provider/model, tokens, latences, noms d'outils, `historyWindowMode`, `contextWindow`, `historyTokensByRole`, statut, classe d'erreur | Tout texte : prompts, réponses, arguments d'outils, résultats d'outils, mémoire, système | Le plus bas : c'est l'exact périmètre de `agent.run.context` + `agent.tool.completed` | Les ids sont des pseudonymes ; un `userId` reste une donnée personnelle au sens strict. Option : le hacher côté exporteur ou l'omettre |
| **B — métadonnées + contenu expurgé** | A + prompt système, messages, arguments et résultats d'outils, après `redactSecrets` (`core/src/events.ts:366`) puis `redactSensitiveText` (`logging/src/redaction.ts`) | Secrets de run connus, emails, tokens à motif connu | Moyen : brancher les deux fonctions, tester les cas limites | **La mémoire injectée et les contenus d'outils non fiables ne sont pas couverts** par une redaction à motifs. Un fichier lu par un outil, une page web, un message utilisateur partent tels quels. La redaction protège des secrets techniques, pas de la vie privée |
| **C — contenu complet, opt-in explicite** | Tout, comme le transcript JSONL local | Rien | Le plus bas en code (seconde implémentation de `PiSessionRecorder`), le plus haut en gouvernance | Nouveau destinataire tiers de contenu utilisateur. `docs/ai-data-sharing-review.md` nomme les destinataires IA dans le parcours de consentement mobile ; un exporteur de contenu en est un et devrait y figurer. **[MAJ 2e passe]** Les tours rejoués portent le `model` du run courant et un usage zéro : exportés tels quels, ils s'affichent comme des générations gratuites sous un modèle qui n'est pas forcément celui qui les a produites (§ 5.4) |

### 3.2 Faits qui contraignent le choix

- **Le logger expurge par construction** (`redactBindings` supprime les clés `prompt`, `message`, `messages`, `body`). Une implémentation « Langfuse = un `LogSink` de plus » est donc **mode A par nature** et ne peut pas devenir B ou C sans contourner la redaction. C'est une propriété désirable si le mainteneur choisit A par défaut.
- **Le transcript local opt-in existe déjà** (`PI_SESSION_RECORDING`, commentaire `pi-session.ts:33` : « Opt-in only. Hosted multi-tenant DATA_DIR transcripts are unencrypted. »). Le mainteneur a déjà tranché une fois : le contenu est opt-in et reste sur la machine. Étendre à un tiers est une décision nouvelle, pas une extension mécanique.
- **AGENTS.md** : aucun vendeur hébergé requis, tout externe optionnel derrière une interface neutre. Une clé Langfuse posée ne doit pas changer ce qui sort par défaut au-delà de ce que le mainteneur a explicitement accepté.

### 3.3 Options de politique par défaut (à trancher)

| Option | Quand `LANGFUSE_*` est configuré et rien d'autre | Argument pour | Argument contre |
|---|---|---|---|
| **A par défaut, B/C par variable dédiée** | Métriques seules | Cohérent avec `agent.run.context` (« never content ») et avec l'opt-in du transcript local ; aucune surprise pour un opérateur qui pose une clé pour « voir les coûts » | Un opérateur qui installe Langfuse veut souvent lire les prompts ; il découvre qu'il doit poser une seconde variable |
| **B par défaut** | Contenu expurgé | Valeur immédiate de Langfuse | La redaction à motifs ne couvre pas la mémoire ni les sorties d'outils ; défaut trop permissif pour un dépôt public multi-tenant |
| **C par défaut** | Tout | Simplicité | Incompatible avec la posture actuelle du dépôt ; non recommandé, listé pour être écarté explicitement |

Le cadrage **ne tranche pas**, mais note que seule la première option est cohérente avec deux décisions déjà prises dans le code (`pi-session.ts:33`, `executor.ts:3770-3771` « Counters only, never content »).

### 3.4 Ce qui peut être tracé sans aucun contenu

Tout ce que Langfuse affiche dans sa vue arborescente hors texte : durée par tour, tokens par tour, cache hit/miss, nombre et durée des appels d'outils, statut, modèle, fenêtre de contexte, mode de fenêtre historique, répartition user/assistant de l'historique. C'est déjà plus que ce que les logs offrent (pas de latence par tour aujourd'hui).

---

## 4. Configuration

Inchangé par le ticket 13. Miroir strict de `createAxiomSinkFromEnv` (`axiom.ts:44-72`).

| Variable | Rôle | Absente | Note |
|---|---|---|---|
| `LANGFUSE_PUBLIC_KEY` | clé publique du projet | exporteur non construit | Nom conventionnel du SDK Langfuse (**à confirmer dans la doc du SDK avant de figer**) |
| `LANGFUSE_SECRET_KEY` | clé secrète | idem | Ne jamais loguer ; `redaction.ts` couvre déjà la clé `api_key` et les motifs `sk-…`, à vérifier pour le préfixe des clés Langfuse |
| `LANGFUSE_BASE_URL` | hôte (cloud ou auto-hébergé) | valeur par défaut du SDK | v3 du SDK lisait `LANGFUSE_HOST`, v5 `LANGFUSE_BASE_URL` (**à confirmer**). Valider `https` comme `resolveAxiomEdge` |
| une variable de mode contenu (nom à fixer) | A / B / C du § 3 | mode A | Seulement si le mainteneur retient un mode au-delà de A |

Comportements attendus, tous déjà écrits dans `@rakazo/logging` pour Axiom :

| Situation | Comportement | Brique existante |
|---|---|---|
| Aucune variable | no-op total, zéro import du SDK exécuté, zéro appel réseau | `createAxiomSinkFromEnv` renvoie `{}` (`axiom.ts:44-72`) |
| Config partielle (une clé sur deux) | un warning unique au démarrage, exporteur désactivé | même fonction, `{ warning }` |
| Réseau ou tiers indisponible | l'écriture est avalée, erreur remontée au plus une fois par 30 s avec compteur | `guardedWrite`, `reportSinkError` (`sink-guard.ts`) |
| Arrêt du process | flush borné, le tiers muet ne retient pas le worker | `logger.flush()` 2 000 ms (`logger.ts`) |
| Erreur dans le hook pendant un run | jamais propagée au run | modèle `BestEffortPiSession` (`pi-session.ts:210-243`) et `onToolCompleted` best-effort (`pi-runtime.ts:1092`) |

**Règle AGENTS.md à respecter** : pas de variable spécifique fournisseur quand la connexion générique suffit. Ici, Langfuse **est** le fournisseur d'un service optionnel (comme Axiom), donc des variables `LANGFUSE_*` au point de composition sont dans la même case que `AXIOM_*`. L'interface interne, elle, ne doit rien connaître de Langfuse.

---

## 5. Ce que ça apporte concrètement ici

### 5.1 Tickets 08 et 09 : le log suffit

| Besoin | Champ déjà émis par `agent.run.context` (`executor.ts:3772-3788`) | Langfuse nécessaire ? |
|---|---|---|
| 08 — part des runs par `historyWindowMode` × `contextWindow` | `historyWindowMode`, `contextWindow` | Non |
| 08 — `historyMessagesKept` vs `historyMessagesAvailable` | les deux compteurs | Non |
| 09 — p50/p95/p99 de `toolSchemaTokens`, `toolCount`, croisés `contextWindow` et providers actifs | `toolSchemaTokens`, `toolCount`, `contextWindow` ; providers via `connectedProviders` ou table `Run`/`UsageRecord` | Non |
| **[MAJ 2e passe]** 13 — effet du rendu natif sur le budget d'historique | `historyTokensByRole` (`:3784`) | Non |

**Constat franc** : Langfuse ne répond pas mieux à 08/09 que le log existant, et coûte un tiers de plus. Les deux tickets portent déjà la case « Destination des logs vérifiée : `AXIOM_TOKEN` / `AXIOM_DATASET` sont optionnels… soit l'activer, soit collecter depuis les logs conteneur sur une fenêtre datée ». **C'est cette case qui débloque 08/09, pas ce cadrage.** Faire les percentiles avec Axiom (APL) ou `jq` sur les logs conteneur est moins de travail que d'installer Langfuse et d'en extraire les mêmes agrégats.

### 5.2 Ce que Langfuse apporterait que rien ne donne aujourd'hui

1. **Latence par tour LLM et par appel d'outil dans une même vue** : la durée outil est en base (`agent.tool.completed`), la durée run est en base (`Run.startedAt/completedAt`), la durée par tour n'existe nulle part. Une trace arborescente rend visible « quel tour a pris 40 s ».
2. **Coût de la compaction** : invisible aujourd'hui (usage jeté, § 1.2). Mais le correctif est indépendant de Langfuse : consommer l'événement `usage` dans `history-compaction.ts:550-558` et l'écrire dans `UsageRecord`/`agent.run.usage` suffit.
3. **Relecture des prompts/réponses cross-run avec filtre** (mode B/C uniquement) : le transcript JSONL local le donne déjà par run, sans UI ni recherche.

### 5.3 `historyTokensByRole` face à L1 **[MAJ 2e passe]**

**Ce que le nouveau champ mesure** : à l'entrée du run, la somme des tokens estimés (`estimateTextTokens`) de `runtimeHistory = [...historicalContext, ...history]` (`executor.ts:3760`), groupée par `message.role` **tel que l'exécuteur le voit** (`:3761-3769`). Clés possibles : `user` et `assistant` seulement, les `system` étant filtrés en amont (`:1414-1427`). Le résumé de compaction et la mémoire rappelée sont poussés en `role: "user"` (`:3665-3680`) et tombent donc dans le seau `user`.

**Ce que L1 mesure** : ce qui se passe **pendant** le run. Latence de chaque tour (`turn_end`, aujourd'hui sans horodatage), tokens réels facturés par tour (événement `usage`), coût de la compaction (aujourd'hui jeté). Aucun de ces trois n'est une estimation d'entrée.

**Recouvrement : nul.** L1 ne rétrécit pas. Une ligne restée : le log `agent.turn.completed` de L1 ne porte que ce qui est propre au tour (durée, tokens réels, model, `stopReason`) ; la composition de l'historique est désormais dite une fois par run dans `agent.run.context`, pas à répéter.

**La réserve « rôle exécuteur ≠ forme sur le fil »** : exacte. `toHistory` (`pi-runtime.ts:771-818`) ne rend natif un tour `assistant` que si `index > 0` après filtrage (`:797`) ; le tour le plus ancien repart en utilisateur marqué `<assistant_turn>`. Or le compteur exécuteur le range dans `assistant`. Deux bornes rendent l'écart petit :
- il porte sur **au plus un message par run** (seul l'index 0 est concerné) ;
- il ne survient que si l'historique **ne commence pas** par un résumé ou une mémoire rappelée, car ceux-ci sont en `user` et occupent l'index 0 quand ils existent (`executor.ts:3665-3680`). Un thread compacté ou un bot avec mémoire n'est donc jamais dans ce cas.
Le marqueur `<assistant_turn>` ajoute une dizaine de tokens non comptés par `estimateTextTokens(m.content)` ; négligeable.

**Verdict plat** : pour la répartition des tokens, le seau exécuteur est un proxy suffisant. Pour répondre « combien de fois le repli s'est déclenché », il ne dit rien, et c'est la seule question qu'il ne peut pas servir. La réponse est un booléen : `runtimeHistory[0]?.role === "assistant"`. Une ligne dans `agent.run.context` (un champ du genre `historyOpensWithAssistantTurn`) le donne. **Pas de ticket** ; à ajouter le jour où quelqu'un pose la question, dans le même commit que L1 si L1 s'ouvre avant.

**Répartition assistant/user sur la vie d'un thread** : c'est `historyTokensByRole` agrégé par `threadId` sur les runs successifs ; les logs portent déjà `thread.id` via `runCorrelatedJob`. Couvert, rien à ajouter.

### 5.4 Où atterrit l'usage à zéro des tours rejoués **[MAJ 2e passe]**

`noUsage()` (`pi-runtime.ts:747-757`) met tous les compteurs et le coût à zéro sur chaque tour `assistant` natif produit par `toHistory`. Trois destinations, tracées :

| Destination | Ce qui s'y passe | Effet sur le coût rapporté |
|---|---|---|
| `initialState.messages` de l'`Agent` Pi (`pi-runtime.ts:335-341`) | Les messages rejoués sont l'état de départ. Pi ne les réémet pas : `message_end` n'est produit que par la boucle de `agent.prompt` (`:442`) ou par `handleRunFailure` (`pi-agent-core/dist/agent.js:349-364`). Aucune somme sur `state.messages` dans `pi-agent-core` (grep `usage` : assignations par message dans `agent-loop.js:509, 550`, rien d'agrégé) | **Aucun.** `agent.run.usage` et `UsageRecord` (`executor.ts:4231-4258`) ne voient que les tours produits pendant le run. Pas de double compte, pas de lignes à zéro venant du rejeu |
| Payload envoyé au fournisseur | Construit par `pi-ai` à partir du rôle et du contenu ; `usage` est un champ de comptabilité côté client | Aucun (**non vérifié en lisant le convertisseur** : `providers/anthropic.js` est un shim de 55 lignes, le convertisseur réel n'a pas été lu ; enjeu faible) |
| Transcript JSONL (`pi-session.ts:202-204`, `initialMessages: history` à `pi-runtime.ts:297`) | Chaque tour rejoué est écrit comme un message `assistant` avec `usage` zéro, `stopReason: "stop"`, et `api`/`provider`/`model` **du run courant** (`:800-802`), pas du run qui l'a produit | **Aucun sur `UsageRecord`.** Mais c'est le piège pour un exporteur de contenu |

**Conséquence pour Langfuse** :
- **Mode A** (métriques, alimenté par les événements `usage` et `AgentToolCompletion`) : aucun effet. Coût par run exact, égal à `UsageRecord`.
- **Mode B/C construit sur le modèle `PiSessionRecorder`** : si l'implémentation mappe `initialMessages` sur des generations Langfuse, chaque tour rejoué apparaît comme une génération à coût nul, étiquetée du modèle courant. Le **coût total du run reste exact** (zéro s'additionne bien), mais le **nombre de générations par run** devient faux, et l'attribution de modèle des tours historiques est mensongère quand le bot a changé de modèle entre-temps. D'où la règle de contrat du § 2 : `initialMessages` = entrée de la trace, jamais des generations.
- Le `UsageRecord` lui-même n'a pas besoin de correction : il n'a jamais reçu ces messages.

**Quirk préexistant, hors diff, hors périmètre** : `handleRunFailure` émet un `message_end` assistant avec `EMPTY_USAGE` ; `pi-runtime.ts:423-431` pousse alors un événement `usage` à zéro et l'exécuteur écrit une ligne `UsageRecord` 0/0 par run échoué. Ce n'est pas le ticket 13 ; noté pour qu'un futur agrégat de coût filtre `inputTokens + outputTokens > 0`.

### 5.5 Alternative « zéro tiers » qui donne 1 et 2

Émettre un log `agent.turn.completed` (durée, tokens réels, model) depuis `pi-runtime.ts:387-416` et capturer l'usage de la compaction. Deux petits changements, mêmes destinations que `agent.run.context`. On obtient la latence par tour sans nouveau vendeur. **[MAJ 2e passe]** Avec `historyTokensByRole` côté entrée et L1 côté exécution, un run est entièrement mesuré localement, hors contenu. À évaluer avant d'ouvrir le chantier Langfuse : si c'est le seul besoin concret, **ce cadrage se conclut par « pas de Langfuse pour l'instant »**.

---

## 6. Découpage en tickets (tracer bullet)

Ordre pensé pour qu'un premier lot livre de la valeur sans tiers, et que Langfuse n'arrive qu'une fois la frontière tranchée. **[MAJ 2e passe]** Structure L0-L4 inchangée ; L1 reformulé d'une ligne, contenu identique.

| # | Ticket | Contenu | Bloqué par | Livrable observable |
|---|---|---|---|---|
| L0 | **Décision frontière de données** | Le mainteneur choisit une politique du § 3.3 et une clé de trace (`runId` proposé). Une ligne dans ce fichier | — | Section § 8 complétée |
| L1 | **Mesures manquantes sans tiers** | Log `agent.turn.completed` (durée, tokens réels, model, `runId`) depuis `pi-runtime.ts:387-416` ou `:357-359` ; consommer `usage` dans `history-compaction.ts:550-558` → `agent.run.usage` + `UsageRecord`. Tests offline avec le runtime scripté. **[MAJ 2e passe]** Ne redit pas la composition de l'historique (déjà dans `agent.run.context`). Optionnel, même commit : booléen « historique ouvert sur un tour assistant » (§ 5.3) | — (indépendant de L0) | Latence par tour et coût compaction dans les logs et en base. **Peut suffire à clore le sujet** |
| L2 | **Interface neutre + no-op** | Un type « recorder de trace » optionnel dans `PiAgentRuntimeOptions` (`pi-runtime.ts:164-167`), hooks run/tour/outil/compaction à 4 endroits (§ 2), implémentation no-op, `BestEffort` calqué sur `pi-session.ts:210-243`. Zéro dépendance ajoutée. Tests offline avec un recorder en mémoire. **[MAJ 2e passe]** Le contrat dit explicitement : `initialMessages` = entrée de trace, jamais des generations (§ 5.4) | L0 (le contrat de données dépend du mode retenu) | Contrat figé, aucun comportement visible ; pas d'entrée CHANGELOG |
| L3 | **Implémentation Langfuse au point de composition** | `createTraceRecorderFromEnv` calqué sur `axiom.ts:44-84` ; câblage dans `apps/worker/src/index.ts:81-84` et `apps/api/src/app.ts:303-308` ; variables dans les deux compose en `${VAR:-}` ; sous-section dans `docs/self-host.md` § Logging ; entrée CHANGELOG (comportement observable par l'opérateur). Test offline avec client injecté comme `axiom.test.ts` | L2 ; choix SDK (§ 7.2) | Traces mode A visibles dans Langfuse quand les clés sont posées |
| L4 | **Mode contenu (si L0 retient B ou C)** | Variable de mode ; passage `redactSecrets` → `redactSensitiveText` (mode B) ; mise à jour `docs/ai-data-sharing-review.md` (nouveau destinataire) ; documenter `PI_SESSION_RECORDING` au même endroit. **[MAJ 2e passe]** Les tours rejoués s'exportent comme entrée, avec leur `model` marqué « modèle courant, pas d'origine » ou omis | L0 (B ou C), L3 | Contenu dans Langfuse, opt-in documenté |

**Chemin le plus court** : L1 seul. **Chemin Langfuse minimal** : L0 → L2 → L3, sans L4.

Critère de décision pour ouvrir L2 : après L1, un besoin concret que les logs + `Event`/`UsageRecord` ne couvrent pas. S'il n'y en a pas, L2-L4 ne s'ouvrent pas.

---

## 7. Choix techniques laissés ouverts

Inchangé par le ticket 13.

### 7.1 Forme de l'interface (deux candidats)

| Forme | Pour | Contre |
|---|---|---|
| **Second `PiSessionRecorder`-like** : interface propre `start(RunTraceStart) → handle { turn(), tool(), end() }` posée à côté du recorder de session | Colle au pattern existant (`pi-session.ts:140-146`), contrat arborescent naturel, mode contenu possible si retenu | Une interface de plus |
| **Langfuse = un `LogSink`** qui reconstruit run → tour → outil à partir de `run.id` et des noms d'événements | Zéro nouvelle interface, redaction gratuite, mode A garanti par construction | Reconstruction d'arbre depuis des événements plats ; mode B/C impossible sans contourner le logger ; le sink reçoit tout le trafic de logs et doit filtrer |

Le ponytail dit : si L0 retient A, la seconde forme est la plus courte. Si L0 laisse B/C ouverts, la première.

### 7.2 SDK Langfuse (vérifié sur le registre npm, non exécuté)

| Paquet | Version constatée | Mode | Dépendances tirées |
|---|---|---|---|
| `langfuse` | 3.39.2 | client classique, pas d'OTel | légères |
| `@langfuse/tracing` / `@langfuse/client` / `@langfuse/otel` / `@langfuse/core` | 5.11.1 | basé OpenTelemetry ; `@langfuse/otel` déclare en peers `@opentelemetry/api ^1.9.0`, `@opentelemetry/core ^2.0.1`, `@opentelemetry/sdk-trace-base ^2.0.1`, `@opentelemetry/exporter-trace-otlp-http` | fait entrer le SDK OTel dans le graphe direct |
| OTLP brut vers l'endpoint Langfuse (sans SDK Langfuse) | — | le plus neutre côté vendeur | **Non vérifié dans cette passe** : existence et format de l'endpoint OTLP de Langfuse à confirmer avant d'en faire une option |

Le dépôt n'utilisant pas OTel en propre, la v3 classique ou l'OTLP brut évitent d'importer une pile de tracing pour un seul exporteur. La v5 a du sens seulement si l'on veut OTel pour d'autres usages plus tard, ce qui est spéculatif aujourd'hui. **Ne pas figer une signature d'API dans un ticket avant d'avoir lu la doc de la version retenue** ; les noms de variables du § 4 sont ceux du SDK et restent à confirmer.

### 7.3 Clé de trace

`runId` (déjà `traceId` dans `AdapterContext`, déjà en base dans `Run`, `Message`, `Event`, `UsageRecord`) plutôt que l'id W3C posé par `runCorrelatedJob`. Le second reste pour corréler les logs ; le premier pour retrouver un run dans Rakazo depuis Langfuse.

---

## 8. Décisions dures laissées au mainteneur

1. **Politique par défaut quand une clé est posée** : métriques seules (A) ou contenu (B/C) ? Le code existant penche deux fois vers A (`pi-session.ts:33`, `executor.ts:3770-3771`). **[MAJ 2e passe]** Inchangée. Le ticket 13 ajoute une caveat au mode C (modèle et usage des tours rejoués, § 5.4), qui n'inverse rien mais alourdit un peu B/C.
2. **Le `userId` sort-il vers le tiers ?** Id opaque, haché, ou omis. Aucune des trois n'est neutre : sans lui, plus de filtre « ce qui arrive à cet utilisateur » ; avec, une donnée personnelle chez un tiers. **[MAJ 2e passe]** Inchangée, rien dans le diff ne la touche.
3. **Faut-il Langfuse du tout après L1 ?** Si la latence par tour et le coût compaction dans les logs suffisent, le reste est spéculatif. **[MAJ 2e passe] Renforcée.** L'entrée du run est maintenant mesurée par rôle localement (`historyTokensByRole`) ; L1 mesure l'exécution. Après L1, ce que Langfuse apporte en exclusivité se réduit à l'interface de navigation arborescente et, en mode B/C, à la relecture cross-run de contenu. Aucun des deux n'est un besoin exprimé par les tickets 01-13.

---

## 9. Ce que le cadrage a corrigé

- **« Si ça n'existe pas »** : ça n'existe pas (ni Langfuse, ni OTel), mais l'idée qu'il faut « ajouter de l'observabilité » est fausse. Le pipeline de logs, l'exporteur optionnel, la redaction, les garde-fous, le `traceId` par run et le transcript opt-in existent. Il manque une latence par tour et l'usage de la compaction, deux corrections sans tiers.
- **Tickets 08/09** : on aurait pu croire que Langfuse est le prérequis des mesures. Non. `agent.run.context` les porte ; la destination d'agrégation est le prérequis, déjà listé dans les deux tickets.
- **Le transcript JSONL** est déjà un traceur de contenu ; un exporteur Langfuse en mode contenu n'est pas une nouvelle capacité, c'est un nouveau destinataire. Cela reclasse la décision comme gouvernance, pas comme technique.
- **[MAJ 2e passe] Deuxième passe (ticket 13)** : on aurait pu croire que `historyTokensByRole` mange une partie de L1. Non : entrée vs exécution, zéro recouvrement. On aurait pu craindre que l'usage à zéro des tours rejoués fausse `UsageRecord`. Non : Pi ne réémet pas l'état initial, seul le transcript JSONL les voit. Le seul vrai apport de la relecture est une règle de contrat pour L2/L4 (« pas de generation depuis `initialMessages` ») et la réserve du mainteneur sur le rôle exécuteur, confirmée mais bornée à un message par run.

---

## 10. Hors périmètre

- Ajouter des cache tokens à `UsageRecord` (indépendant ; à porter dans un ticket coût si besoin).
- Passer le `traceId` d'`AdapterContext` au format W3C ou unifier avec `runCorrelatedJob`.
- Instrumentation OTel générale (HTTP, Prisma, jobs) : aucun besoin exprimé.
- Évaluations / scores Langfuse, datasets, prompts gérés côté Langfuse.
- Tracer les appels mémoire (`semanticMemory.provider.save`, `history-compaction.ts:604-612`) ou les fournisseurs mémoire : autre frontière de données, autre cadrage.
- Chiffrer le transcript JSONL local.
- **[MAJ 2e passe]** La ligne `UsageRecord` 0/0 écrite par run échoué (`handleRunFailure` → `EMPTY_USAGE`), préexistante au ticket 13.
- **[MAJ 2e passe]** Persister le modèle d'origine des tours historiques pour que le rejeu porte le bon `model` : question de données de `Message`, pas d'observabilité.

---

## 11. Non vérifié dans cette passe (à confirmer avant implémentation)

- Noms exacts des variables lues par le SDK Langfuse retenu (`LANGFUSE_BASE_URL` vs `LANGFUSE_HOST`).
- Existence et contrat de l'endpoint OTLP de Langfuse.
- Signatures d'API du SDK (aucune n'est proposée ici volontairement).
- Si Pi expose un `stopReason` ou un horodatage de début de tour exploitable pour la generation ; sinon, mesurer côté Rakazo entre `message_update` initial et `message_end`.
- **[MAJ 2e passe]** Que le convertisseur `pi-ai` vers le payload fournisseur ignore bien le champ `usage` des messages `assistant` (déduit du rôle du champ, non lu dans le code du convertisseur).
- **[MAJ 2e passe]** Retiré de cette liste : la ligne de l'usage imbriqué des sous-agents, désormais vérifiée à `pi-runtime.ts:1223-1231`.
