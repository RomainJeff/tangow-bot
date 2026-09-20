# 21: Apprendre les faits durables au moment de la compaction

**What to build:** Un utilisateur qui dit « appelle-moi Rom, tutoie-moi, le repo c'est `rakazo-bot` » au fil d'une longue conversation les retrouve dans la mémoire du bot le lendemain, sans avoir eu à dire « souviens-toi ». Aujourd'hui rien de ce qui n'est pas passé par un appel explicite à `remember` ne survit à la compaction : le résumé garde la conversation, pas les leçons. Le bot doit extraire, à chaque lot compacté, les faits durables nouveaux et les ajouter à sa mémoire — visibles et corrigeables dans l'écran Knowledge dès le tour suivant. C'est l'avantage à préserver sur un Grok Bot : l'utilisateur voit ce que le bot a retenu et peut l'éditer.

## Ce que le cadrage a établi

**La compaction a déjà tout sous la main, sauf la mémoire.** Le job lit le lot de messages, lance un run court, écrit le résumé et avance le curseur, puis pousse le résumé au fournisseur sémantique en portée isolée. Il reçoit ses dépendances explicitement (base, runtime, jobs, fournisseurs sémantiques, modèle) mais pas le store de mémoire explicite. Prefactor : lui passer ce store. Un seul point d'appel, dans les handlers de jobs de fond.

**Second run, pas second travail du résumé.** Le résumé de compaction a un contrat (checkpoint structuré, ticket P0-3) ; y mêler une extraction de faits dégrade les deux. Un second run court, après que le curseur a avancé, reçoit le transcript du lot et la mémoire actuelle du bot, et rend une liste de puces — ou rien. Ce qui compte comme durable : préférences de l'utilisateur, décisions prises, identifiants de ressources nommées (repo, canal, projet), corrections faites au bot. Ce qui n'en est pas : le fil de la tâche en cours, déjà porté par le résumé.

**Écriture en ajout, sous un titre daté.** Les puces s'ajoutent à `MEMORY.md` du bot sous un en-tête `## Learned <date>` via l'ajout atomique du ticket 20 — pas de remplacement, pas de read-then-write. L'utilisateur distingue d'un coup d'œil ce que le bot a appris seul de ce qu'il lui a dicté, et peut supprimer ou déplacer.

**Garde-fous, tous des non-écritures.** Sortie vide → aucune révision. Plus de dix puces → tronquer à dix. Secrets → passer par la redaction existante avant écriture ; rien de ce qui ressemble à un jeton ou une clé n'atteint la mémoire. Un thread sans bot propriétaire (groupe) → hors périmètre tant que le ticket 12 n'est pas tranché. Un thread de canal de messagerie → jamais, frontière posée dans `NON-GOALS.md` (runs de canal volontairement sans mémoire). Échec du second run → la compaction reste valide, on journalise, on ne réessaie pas.

**Coût visible.** Le second run consomme des tokens ; son usage s'enregistre comme celui du résumé (ticket 17 en pose le rail pour la compaction). Une ligne de log par compaction : nombre de faits ajoutés, zéro inclus.

**Pas de déduplication sémantique en v1.** Le run reçoit la mémoire actuelle et la consigne de ne lister que ce qui en est absent ; les doublons qui passent se corrigent dans Knowledge. Ajouter un juge ou une passe de fusion est un ticket ultérieur, ouvert seulement si les doublons gênent en pratique.

**Blocked by:** 20 (l'ajout atomique au document de mémoire)

**Status:** ready-for-agent

- [ ] Après compaction d'un thread direct, les préférences, décisions et corrections exprimées dans le lot apparaissent dans `MEMORY.md` du bot sous un en-tête daté, et sont visibles et éditables dans l'écran Knowledge
- [ ] Un lot sans fait durable nouveau ne produit aucune révision
- [ ] Jamais plus de dix puces par lot ; les secrets sont redactés avant écriture
- [ ] Aucune écriture pour un thread de groupe ni pour un thread de canal ; l'échec du second run n'invalide pas la compaction
- [ ] L'usage du second run est enregistré comme celui du résumé ; une ligne de log donne le nombre de faits ajoutés
- [ ] Le prompt système invite à appeler `remember` dès qu'une préférence ou une correction est exprimée (texte statique, préfixe stable préservé)
- [ ] Tests offline et déterministes via le runtime stubbé ; CHANGELOG mis à jour
