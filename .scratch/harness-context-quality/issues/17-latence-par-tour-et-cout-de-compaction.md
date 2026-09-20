# 17: Mesurer la latence par tour et le coût de la compaction

**What to build:** Un opérateur qui regarde ses logs peut répondre à « quel tour a été lent ? » et « combien me coûte la compaction ? ». Aujourd'hui il ne le peut pour ni l'un ni l'autre, et c'est le seul trou de mesure réel du harness — tout le reste (tokens d'entrée, composition de l'historique, durée d'appel d'outil, usage par run) est déjà émis ou persisté.

Deux manques, de nature différente, qui se réparent séparément.

**Le coût de la compaction est jeté.** La compaction lance un vrai run de modèle, mais ne consomme que `text` et `done` du flux ; l'événement `usage` que le runtime émet déjà est ignoré et aucune ligne `UsageRecord` n'est écrite. Le coût réel de la compaction n'apparaît donc nulle part — ni dans les logs, ni en base, ni dans la facture rapprochée d'un thread. Rien à inventer ici : l'événement arrive, il suffit de le consommer comme n'importe quel autre run.

**La latence par tour n'est mesurée nulle part.** `turn_end` est traité sans horodatage et aucune ligne `agent.turn.*` n'est émise. Mais il ne faut pas l'instrumenter à la main : le harness **publie déjà un contrat de télémétrie**. `@earendil-works/pi-telemetry` est dans le graphe de dépendances (transitif, zéro dépendance propre) et définit des spans neutres, un no-op partagé, un adaptateur de référence en mémoire, des schémas typés et une suite de conformance d'adaptateur. `pi-agent-core` possède les schémas `pi.ai.*` et `pi.harness.*`, et le span `pi.ai.request` porte déjà exactement ce que ce ticket demande : durée, `time_to_first_chunk_ms`, tokens in/out/cache/reasoning/total, coût, `stop_reason`, provider, modèle, classe d'erreur. `pi-ai` accepte un `telemetryContext` dans ses options de requête.

Rakazo n'en câble rien : aucune occurrence de `telemetryContext` dans `packages/` ni `apps/`. Le point d'injection est unique — attacher un contexte de télémétrie au `Context` pi — et le no-op partagé est le défaut quand on n'attache rien.

Le chemin le plus court est donc un adaptateur qui traduit les spans pi vers le logger structuré existant, pas un chronométrage maison. Il donne plus de champs, il est typé et versionné par le schéma, il est testable avec la suite de conformance fournie, et il rend le ticket 18 quasi gratuit : le même adaptateur, pointé ailleurs, est l'exportateur tiers.

Contrainte de données inchangée : compteurs et identifiants, jamais de contenu. Le schéma pi va dans le même sens — il marque les attributs sensibles et recommande explicitement de tenir les prompts, complétions, arguments et sorties d'outils hors des attributs.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Un run de compaction écrit son usage au même endroit que n'importe quel autre run : log d'usage et ligne `UsageRecord`
- [ ] La durée d'un tour de modèle, son temps jusqu'au premier chunk et ses tokens réels sont lisibles dans les logs
- [ ] Ne rien attacher laisse le comportement strictement inchangé, via le no-op du contrat
- [ ] L'adaptateur passe la suite de conformance fournie par le contrat, ou bien l'approche est abandonnée au profit d'un chronométrage local et le ticket dit pourquoi
- [ ] Aucune des nouvelles lignes ne contient de contenu, seulement des compteurs et des identifiants
- [ ] Les tests restent offline et déterministes
