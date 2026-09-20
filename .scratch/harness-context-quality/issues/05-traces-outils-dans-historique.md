# 05: Conserver les traces d'outils d'un tour à l'autre

**What to build:** Au tour suivant, le bot sait quels outils il a appelés au tour précédent, avec quels arguments et ce qu'ils ont retourné. Aujourd'hui il ne voit que le texte final de sa réponse : le bloc qui porte les appels d'outils est rendu en chaîne vide lors de la conversion de l'historique en texte. Conséquences observées : relecture du même fichier, nouvel appel web identique, annonce d'une vérification déjà faite.

Les données sont déjà persistées en base — nom, entrée, sortie, déjà tronqués à l'enregistrement. Il s'agit de les rendre, pas de les collecter.

Rendu : une ligne compacte par appel, du type `[tool <nom>(<entrée abrégée>) → <sortie abrégée>]`, avec un plafond dur par appel et par bloc. L'ancien format sans détail d'appels se rend en `[tools: <label> ×<n>]`. Pas de nouveau délimiteur de sécurité : le contenu d'outil est déjà couvert par la règle « données non fiables » du système.

Le même rendu alimente le transcript de compaction : les résumés pourront enfin remplir leur section « actions / fichiers touchés », aujourd'hui structurellement vide.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Les appels d'outils d'un tour apparaissent dans l'historique du tour suivant, une ligne par appel
- [ ] Plafonds durs sur l'entrée et la sortie de chaque appel, et sur le bloc entier ; pas de secret ni de charge utile brute recopiée
- [ ] Les blocs de l'ancien format (sans détail d'appels) se dégradent proprement, sans exception
- [ ] Le transcript de compaction inclut ces traces
- [ ] Test offline : un scénario « tour 1 lit une ressource, tour 2 pose une question dessus » ne redéclenche pas le même appel d'outil
