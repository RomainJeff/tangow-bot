# 05: Vérification post-action `landed / dialog / error / auth / unchanged`

**What to build:** Après un `browser_act`, le résultat dit ce que l'action a produit — la page a changé comme attendu (`landed`), un dialogue ou une modale s'est ouvert (`dialog`), un message d'erreur est apparu (`error`), un mur d'authentification ou une vérification anti-bot bloque (`auth`), ou rien de visible n'a changé (`unchanged`) — avec une confiance. Le modèle lit une ligne au lieu de comparer deux snapshots. C'est consultatif : le backend n'agit jamais dessus tout seul.

## Pourquoi ce n'est pas un appel de plus

`BrowserActResult` contient déjà `url`, `title`, `tree`, `elements` d'après (`packages/adapter-kit/src/types.ts`), et `resolveBrowserTargets` (ticket 04) ou le modèle disposent du snapshot d'avant. La vérification est une question posée sur un état que nous avons déjà en main, entre le retour du helper et le retour au modèle. Un appel au fournisseur, aucun appel helper supplémentaire.

## Ce qu'on change

**L'état** : `{ action: { kind, target: { role, name } }, before: { url, title, headings, dialogRoles, elementCount }, after: { url, title, headings, dialogRoles, elementCount, textHead } }`. `headings` = les entrées de rôle `heading` du snapshot (le helper les rend déjà, `rakazo-page-browser:375`), `dialogRoles` = présence d'éléments à rôle `dialog`/`alertdialog`/`alert` ou de mots-clés de modale dans les premiers éléments, `textHead` = les 1 500 premiers caractères du texte de page d'après, redigés par `redactSecrets`. Borné, structuré, pas de HTML.

**La question** : un seul appel, deux questions sur le même état pour ne payer le `state` qu'une fois —
`outcome: choice(…, { landed, dialog, error, auth, unchanged })` et `blocked: noul("Is the page now asking the user to sign in, solve a challenge, or prove they are human?")`. `blocked` est là parce que `auth` est le cas le plus coûteux à manquer (le bot tourne en rond sur une page de connexion) et qu'une seconde lecture indépendante sur la même passe est gratuite. Règle de fusion, écrite : `blocked ≥ 0,8` force `auth` quelle que soit la `choice`.

**Le résultat** : `BrowserActResult.outcome?: { kind, confidence }`, présent seulement quand un fournisseur a répondu ; absent sinon, jamais inventé. Sous un seuil bas (`low`, départ 0,5, calibré en 06), on rend `outcome: { kind: "uncertain", confidence }` plutôt que rien : le modèle sait qu'on a regardé et qu'on n'a pas su.

**Ce que le backend fait de l'issue** : rien d'autre que la rendre. Pas de rejeu sur `unchanged`, pas de nouvelle tentative sur `error`, pas de `request_takeover` automatique sur `auth`. L'instruction système (`executor.ts:850`) gagne, conditionnée à la présence d'un fournisseur, une phrase : sur `auth`, demander la prise de contrôle plutôt que d'insister ; sur `unchanged`, inspecter avant de recommencer. C'est le modèle qui décide, comme le contrat l'exige.

**Où ça s'exécute** : dans `browserActFromTool` (`browser-tools.ts`), après le retour du provider et avant `formatBrowserResult`. Le snapshot d'avant vient de la résolution `target` (04) quand elle a eu lieu, sinon du dernier `browser_snapshot` du run si l'exécuteur le garde — sinon on vérifie avec `before` réduit à `url`/`title` seulement et on le dit dans le `state`. `uncertain: true` du provider (réponse d'action perdue) court-circuite la vérification : on ne classe pas l'issue d'une action dont on ne sait pas si elle a eu lieu.

## Références de conception

`jevkit.verify` : mêmes classes plus `gate`, et la règle « `auth` et `error` gatent toujours `stop` » — chez nous il n'y a pas de gate parce qu'il n'y a pas de boucle à arrêter : le modèle reprend la main après chaque action de toute façon. `jev-for-chrome` : la détection de boucle (même contrôle 3× en 6 pas sans changement) est une heuristique de compteur, pas une décision de modèle ; si 08 montre des boucles sur `unchanged`, elle se code en cinq lignes dans l'exécuteur sans fournisseur. `jev-use` : la vérification indépendante par un endpoint `/state` du fixture est le modèle de nos tests, pas du produit.

## Fichiers

- `packages/adapter-kit/src/types.ts` — `BrowserActResult.outcome`, type `BrowserActOutcome`.
- `packages/adapters/src/browser-tools.ts` — `verifyBrowserOutcome(before, after, action, provider)`, construction de l'état borné, fusion `blocked`, seuil `low`.
- `packages/adapters/src/executor.ts` — conserver le dernier snapshot du run par ordinateur pour servir de `before` quand l'action est à `ref` ; phrase d'instruction conditionnelle.
- `packages/adapters/src/browser-tools.test.ts` — pages seedées avant/après pour chacune des cinq classes, fake scripté ; `uncertain` court-circuite ; `unavailable` → pas d'`outcome` ; `blocked` force `auth`.
- `docs/computer-runtime.md` — la phrase « a failed action reports confirmed progress and whether its outcome is uncertain » gagne : « and, when a decision provider is connected, a classified outcome the model should read before continuing ».

## Vérification

Offline, vitest, `FakeBrowserProvider` + `FakeDecisionProvider` scripté. Cinq paires de pages HTML seedées (`FakeBrowserProviderOptions.pages`) : formulaire → page de confirmation, bouton → modale, soumission → message d'erreur, lien → page de connexion, clic → même page. Le test affirme la forme de l'état envoyé (bornes, redaction, absence de mot de passe), la fusion, l'absence d'`outcome` sans fournisseur, et qu'aucun `act` supplémentaire n'est jamais émis par le vérificateur.

## Ce qui reste ouvert

- `before` pour une action à `ref` sans snapshot conservé : vérifier sur `url`/`title` seuls dégrade la classe `unchanged`/`landed` mais garde `auth`/`error`/`dialog`, qui ne dépendent que de l'après. Acceptable en v1 ; 06 mesure la perte.
- L'anti-bot (Cloudflare « vérifiez que vous êtes humain ») rentre dans `auth` par la question `blocked` ; faut-il une classe `challenge` séparée ? Attendre 06 : si les deux se confondent dans les fixtures, une classe suffit.
- Le coût : deux questions sur ~2 500 caractères, soit de l'ordre de 700 tokens, ~0,00003 $ par action. Négligeable ; la latence (une requête) est ce que 08 mesure.

**Blocked by:** 02, puis la mesure de 04 par 08

**Status:** différé (décision du ticket 01) — n'économise aucun token, ajoute une latence, et livré avec 04 rendrait la mesure de 08 inattribuable. À rouvrir une fois 04 mesuré ; il héritera alors du `before` complet sans faire retenir un snapshot à l'exécuteur.

- [ ] `outcome` est présent seulement quand un fournisseur a répondu ; jamais un défaut inventé
- [ ] `uncertain: true` du provider empêche toute vérification
- [ ] `blocked ≥ 0,8` force `auth` ; test dédié
- [ ] Sous le seuil `low`, `outcome.kind` vaut `uncertain` avec la confiance
- [ ] Aucun chemin ne rejoue, ne relance ni ne déclenche `request_takeover` à partir de l'issue ; le test affirme qu'aucun appel provider n'est émis par le vérificateur
- [ ] L'état envoyé est borné (constantes nommées), redigé, sans HTML ni valeur de mot de passe
- [ ] Sans fournisseur, `browser_act` est strictement inchangé
- [ ] `docs/computer-runtime.md` mis à jour ; entrée CHANGELOG (le bot dit ce que son action a produit)
