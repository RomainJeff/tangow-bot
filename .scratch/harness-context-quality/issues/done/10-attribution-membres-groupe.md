# 10: Attribuer les tours des bots membres d'un groupe

**What to build:** Dans un thread de groupe, un bot qui relit l'historique ne prend plus les tours des autres membres pour les siens. Aujourd'hui il les prend : les posts et les `handoff` des autres bots membres sont stockés avec le rôle `bot` et le `botId` de leur auteur, mais l'historique du run les remonte sans filtre sur le bot et sans sélectionner `botId`, puis mappe tout rôle non-`user` / non-`system` vers `assistant`. Résultat : la décision d'un pair se relit comme une décision que le bot aurait prise lui-même, et un `handoff` se rend en identifiants bruts (`[handoff <id> -> <id>]`) qui ne désignent personne de lisible.

Le ticket 06 a rendu le marquage explicite (`<assistant_turn>`, bloc `<bot_message from=…>`) mais n'a pas touché à l'attribution : un tour de membre porte toujours le marqueur assistant. C'est ici qu'on le corrige.

Portée : le chemin sans `channelId`. Le chemin canal messagerie filtre déjà les tours `bot` sur le run courant, donc il n'expose pas les pairs ; c'est le thread de groupe ordinaire (réveil par message utilisateur ou par handoff) qui n'a aucun filtre.

Trois pièces : `botId` dans le `select` du chargement d'historique, une branche de mapping qui distingue « écrit par ce bot » de « écrit par un autre membre », et une résolution id→nom pour nommer l'auteur. Le roster du groupe est déjà chargé avec `id`, `name`, `title`, `description` pour construire le contexte groupe — il est actuellement rendu en chaîne puis jeté. Le réutiliser plutôt que d'ouvrir une seconde lecture.

Le marquage d'un tour de membre réutilise celui d'un message de pair (bloc nommé), déjà partagé entre l'historique et le prompt de réveil depuis le ticket 06 : pas de troisième forme à inventer.

**Blocked by:** 06 (marquage explicite des tours), mergé

**Status:** done — mergé en `88176952`

- [x] Dans un thread de groupe, un post d'un autre bot membre est attribué à ce bot dans l'historique, avec son nom, et ne porte pas le marqueur de tour assistant
- [x] Un `handoff` entre deux membres se lit avec les noms des bots, pas leurs identifiants
- [x] Les tours du bot lecteur lui-même restent marqués comme siens
- [x] Un membre archivé ou absent du roster dégrade proprement (pas de nom inventé, pas d'exception)
- [x] Le chemin canal messagerie garde son comportement actuel
- [x] La résolution id→nom réutilise le roster déjà chargé pour le contexte groupe, sans requête supplémentaire par message
- [x] Test offline : historique de groupe où le membre B écrit « j'ai déployé », relu par le bot A — le rendu attribue l'action à B
