# Native MCP pour Codex et Claude

L'entrée MCP native reste désactivée tant que `RAKAZO_NATIVE_MCP_PORT` et
`RAKAZO_NATIVE_MCP_RELAY_SECRET` ne sont pas tous les deux définis. Configurez
le relais du superviseur vers cette entrée avant de l'activer.

`RAKAZO_NATIVE_MCP_HOST` choisit l'adresse d'écoute du worker. Sa valeur par
défaut est `worker`, le nom DNS du réseau Compose interne. Les adresses joker
`0.0.0.0` et `::` sont refusées : le port ne doit jamais être ouvert sur toutes
les interfaces.

`RAKAZO_NATIVE_MCP_UPSTREAM`, côté superviseur, est l'URL complète de l'entrée du
worker, chemin compris : par exemple `http://worker:7093/native-mcp`. Le relais la
transmet telle quelle, et une URL sans le chemin `/native-mcp` reçoit 404.

Pour surcharger `RAKAZO_NATIVE_MCP_HOST` avec Compose, transmettez explicitement
cette variable au service worker dans votre overlay : les fichiers Compose de
base conservent la valeur interne par défaut. Le secret du relais reste dans le
superviseur et le worker ; les Computers ne reçoivent que leur ticket de run.

Le relais accepte uniquement `POST` sur `/native-mcp` (`GET` et `DELETE` donnent
405) et borne l'appel amont à 120 secondes. `run_subagent` est exclu du catalogue
natif parce qu'un tour imbriqué peut parquer le run appelant.

Après chaque tour Codex, le ticket est désarmé et son transport MCP fermé. Le
processus Codex peut rester parqué avec l'ancien `mcp-session-id`. Au ré-armement,
le worker répond 404 à cet identifiant expiré, après vérification du ticket et du
Computer. Le client réémet `initialize` sans cet en-tête, reçoit une nouvelle
session, puis répète son appel sous l'autorité du nouveau run. Entre les tours,
le ticket désarmé reste refusé en 401.

Ce comportement de reprise est celui de `rmcp` 3.2.0, dépendance épinglée par
[Codex 0.154.0](https://github.com/openai/codex/blob/rust-v0.154.0/codex-rs/Cargo.lock),
avec `reinit_on_expired_session` activé par défaut dans son
[transport HTTP](https://docs.rs/rmcp/3.2.0/src/rmcp/transport/streamable_http_client.rs.html).
Le test hors ligne `rakazo-mcp-http.test.ts` rejoue ce contrat avec un faux
app-server, le runtime Codex réel et deux appels HTTP réussis dans un seul processus.
