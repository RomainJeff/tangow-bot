# 17: Mesurer la latence par tour et le coût de la compaction, sans tiers

**What to build:** Un opérateur qui regarde ses logs peut répondre à « quel tour a été lent ? » et « combien me coûte la compaction ? ». Aujourd'hui il ne le peut pour ni l'un ni l'autre, et c'est le seul trou de mesure réel du harness — tout le reste (tokens d'entrée, composition de l'historique, durée d'appel d'outil, usage par run) est déjà émis ou persisté.

Deux manques, tous deux réparables sans dépendance ni destinataire externe :

- **Aucune latence par tour LLM.** `pi-runtime.ts` traite `turn_end` sans horodater, et aucune ligne `agent.turn.*` n'est émise. La durée totale d'un run est déductible de `Run.startedAt/completedAt`, la durée d'un appel d'outil existe déjà dans la table `Event` — mais entre les deux, le temps passé par le modèle à produire un tour est invisible. Si Pi n'expose pas d'horodatage de début de tour exploitable, mesurer côté Rakazo entre le premier `message_update` et le `message_end`.
- **L'usage de la compaction est jeté.** La compaction lance un vrai run de modèle, mais ne consomme que `text` et `done` du flux ; l'événement `usage` est ignoré et aucune ligne `UsageRecord` n'est écrite. Le coût réel de la compaction n'apparaît donc nulle part — ni dans les logs, ni en base, ni dans la facture rapprochée d'un thread.

Ce que ce ticket ne fait pas : redire la composition de l'historique. `agent.run.context` porte déjà `historyTokens`, `historyTokensByRole`, `historyWindowMode`, `contextWindow`, `toolSchemaTokens`. Le nouveau log mesure l'**exécution**, pas l'**entrée** — zéro recouvrement, et rien à dupliquer.

Contrainte de données : ces lignes sont des compteurs, jamais du contenu, comme `agent.run.context` l'affiche déjà en commentaire. Aucun prompt, aucune réponse, aucun argument d'outil.

Ce ticket est le chemin court du cadrage `langfuse-observabilite.md` (lot L1). Il est volontairement indépendant du ticket 18 : il ne suppose aucune décision sur un exportateur tiers, et il est le critère qui décide si le ticket 18 s'ouvre un jour.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Chaque tour du modèle émet une ligne de log portant sa durée, ses tokens réels (in/out/cache si disponibles), le provider, le modèle et le `runId`
- [ ] Un run de compaction écrit son usage au même endroit que n'importe quel autre run : log d'usage et ligne `UsageRecord`
- [ ] Aucune des nouvelles lignes ne contient de contenu, seulement des compteurs et des identifiants
- [ ] Les tests restent offline et déterministes, avec le runtime scripté existant
- [ ] Le coût d'une compaction sur un thread réel est lisible a posteriori depuis les logs ou la base, sans outil tiers
