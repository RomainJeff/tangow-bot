# 20: Faire de `remember` un ajout, pas un remplacement

**What to build:** Quand le bot appelle `remember` deux fois dans une conversation, l'utilisateur retrouve les deux faits dans la mémoire du bot. Aujourd'hui il n'en retrouve qu'un : le second appel remplace intégralement le document, et le premier fait disparaît sans trace autre qu'une révision archivée. L'outil est décrit au modèle comme « stocker un fait durable », il se comporte comme « réécrire toute la mémoire ». Chaque fait mémorisé doit s'empiler ; la mémoire ne rétrécit que si un humain la modifie depuis l'écran Knowledge.

## Ce que le cadrage a établi

**Le remplacement est dans le contrat du store, pas dans le handler.** L'écriture mémoire est une transaction « mettre à jour le contenu, révision + 1, ou créer » qui prend le contenu complet en argument. Le handler de `remember` lui passe le texte du modèle tel quel, chemin par défaut `MEMORY.md`. Le résultat est correct pour l'écran Knowledge, qui édite le document entier et a besoin d'un remplacement ; il est faux pour l'outil, qui n'exprime qu'un fragment.

**L'append doit vivre dans la transaction, pas autour.** Un « lire puis réécrire avec le fragment en plus » côté handler perd des faits dès que deux runs du même bot tournent en parallèle — deux threads directs, ou un thread plus un run de compaction (ticket 21 en écrira depuis un job de fond). Le store a déjà la transaction avec retry ; c'est là que l'ajout doit être exprimé, comme une intention distincte du remplacement. Une révision par appel, comme aujourd'hui, pour que l'historique reste lisible.

**Le prompt promet l'outil même quand il est retiré.** La sélection des outils mémoire retire `remember` dès qu'un fournisseur sémantique est configuré, mais la phrase « Use remember for durable facts » reste dans le prompt système. Le modèle est invité à appeler un outil qui n'existe pas. La phrase doit suivre l'exposition de l'outil, et dire quand s'en servir : préférence exprimée, correction, fait stable donné par l'utilisateur → mémoriser tout de suite, pas à la fin de la conversation. Texte statique, aucun impact sur la stabilité du préfixe (ticket 02).

**Le format n'est pas le sujet.** Une ligne par fait, puce Markdown, séparateur de ligne si le document n'en finit pas par un. Pas de déduplication, pas de section, pas de structure : l'écran Knowledge est l'endroit pour ranger, et 21 introduira son propre en-tête daté.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Deux appels `remember` successifs sur le même bot produisent un document qui contient les deux faits, dans l'ordre d'appel
- [ ] Chaque appel produit exactement une révision ; un document vide ou absent est créé au premier appel
- [ ] Deux ajouts concurrents sur le même document ne perdent aucun fait (test avec le retry de transaction, pas de read-then-write côté handler)
- [ ] L'édition depuis l'écran Knowledge et l'import Markdown restent des remplacements complets, comportement inchangé
- [ ] La phrase du prompt sur `remember` n'apparaît que lorsque l'outil est effectivement exposé, et dit quand l'appeler
- [ ] La description de l'outil décrit le comportement réel
- [ ] Tests offline et déterministes ; CHANGELOG mis à jour
