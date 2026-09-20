# 06: Ne plus faire passer les messages de bots pairs pour les siens

**What to build:** Quand un bot relit l'historique d'un thread, il distingue ses propres réponses des messages reçus d'un autre bot. Aujourd'hui non : un message de pair est mappé vers le rôle assistant, puis l'historique entier est aplati en messages utilisateur préfixés `Assistant: `. Un message reçu d'un pair se relit donc comme `Assistant: [from <pair>] …`, c'est-à-dire comme une décision que le bot aurait prise lui-même. Le marquage correct (`[bot]`, bloc `<bot_message from=…>`) n'existe que dans le prompt du tour de réveil, il ne survit pas dans l'historique.

Le changement reste dans l'aplatissement actuel — on ne fabrique pas de faux messages assistant, ce serait un autre ticket et un autre coût. On remplace le préfixe ambigu par un marquage explicite et distinct : un délimiteur pour les tours assistant, un autre pour les tours de pairs portant le nom du pair, cohérent avec ce que voit déjà le bot au moment du réveil. Effet de bord corrigé au passage : un message utilisateur commençant par `Assistant:` n'est plus indiscernable d'un tour assistant.

**Blocked by:** None (can start immediately)

**Status:** done — mergé en `f8333a95`

- [ ] Un message reçu d'un bot pair est marqué comme tel dans l'historique, avec le nom du pair, et n'est plus présenté comme un tour de l'assistant
- [ ] Les tours de l'assistant portent un marquage explicite, non imitable par du texte utilisateur
- [ ] Le marquage dans l'historique est cohérent avec celui du prompt de réveil inter-bots
- [ ] Les messages stockés avec un rôle système restent exclus de l'historique, comme aujourd'hui
- [ ] Test offline : dans un historique où un pair a écrit « fais X », le rendu ne laisse pas penser que le bot l'a décidé
