# 04: Choix de cible pour `browser_act` par `choice` sur les refs du snapshot

**What to build:** Le modèle peut dire « clique le bouton Télécharger CSV » sans avoir lu la page. `browser_act` accepte, pour chaque action, soit `ref` (inchangé, déterministe, sans fournisseur), soit `target` : une description courte de l'élément visé. Quand `target` est présent, le backend prend un snapshot, pose au fournisseur de décision un `choice` sur les refs courants plus une option réservée `none`, exécute l'action sur le ref choisi si la confiance passe le seuil, et sinon rend les candidats au modèle, qui choisit un ref lui-même comme aujourd'hui. Le modèle principal ne lit plus 12 000 caractères de page pour cliquer un bouton ; il les lit seulement quand la décision n'est pas nette.

## Pourquoi c'est le bon point d'accroche

- La table est déjà là et déjà bornée : `BrowserSnapshotResult.elements`, ≤80 entrées, chacune `{ ref, role, name, value?, tag? }`. Elle devient la map d'options du `choice`, clé = `ref`, description = `role`, `name`, `value` (masqué pour les mots de passe, déjà fait par le helper).
- Le fail-closed existe en deux endroits et on n'en ajoute pas un troisième : l'enveloppe du ticket 02 refuse une réponse hors map ; le préflight du helper (`rakazo-page-browser:567`) refuse un ref devenu périmé entre le snapshot et l'action. Si la page bouge entre les deux, c'est une erreur rendue au modèle avec un snapshot frais, pas un retargeting.
- `act` renvoie déjà le snapshot d'après ; le ticket 05 s'y branche sans appel supplémentaire.

## Ce qu'on change

**Le schéma de l'outil** (`packages/adapters/src/builtin-tools.ts:95`) : `ref` devient optionnel, `target` optionnel, exactement l'un des deux requis, validé dans `parseBrowserActions` (`browser-tools.ts:76`). La description de l'outil gagne une phrase, seulement quand un fournisseur est présent : le texte de l'outil est composé au run (`selectBuiltinToolsForRun`, `executor.ts:1646`), donc un déploiement sans fournisseur ne voit pas `target` du tout. Pas de copie qui explique une capacité absente.

**La résolution** (`packages/adapters/src/browser-tools.ts`, nouvelle fonction `resolveBrowserTargets`) : pour chaque action à `target`, dans l'ordre —

1. `browser.snapshot()` — un appel helper. Si `fallback`, on rend le fallback tel quel.
2. `state` = `{ goal: target, page: { url, title }, elements: [{ id: ref, role, name, value }] }`. Pas de texte de page libre dans cet usage : la question porte sur les contrôles, et le texte est ce qui coûte. Le `state` passe par `redactSecrets` (`@rakazo/core`) avec les secrets du run, comme `redactToolArgsForReview`.
3. `questions = { target: choice("Which element matches the goal? Answer none if no element does.", { ...refs, none: "no listed element matches" }) }`. Une question, un appel.
4. `decideWithin(provider, …, { timeoutMs })`. `unavailable` → on rend `{ ok: false, completed, needsRef: true, tree, elements, reason }` : le modèle reçoit le snapshot et choisit un ref, c'est-à-dire exactement le tour d'aujourd'hui avec un appel d'outil en moins.
5. Gate : `confidence ≥ high` → exécuter ; sinon → même retour `needsRef` avec les trois meilleurs candidats et leurs probabilités dans `candidates`, pour que le modèle tranche sans relire toute la page. `none` choisi → `needsRef` sans candidats. Pas de niveau `caution` qui exécute : une cible incertaine ne se clique pas, elle se rend.
6. Exécuter par le chemin existant : `browser.act({ actions: [{ kind, ref, text? }] })`. `text` reste celui du modèle ; Jev ne l'écrit jamais.

**Plusieurs actions dans un appel** : `MAX_BROWSER_ACTIONS = 24` reste pour les actions à `ref`. Les actions à `target` se résolvent une par une, chacune avec un snapshot frais, parce que la première change la page ; borne séparée (proposition : 6 par appel) écrite en constante à côté de l'autre. Une résolution qui rend `needsRef` arrête la séquence et rapporte `completed`, comme une action échouée aujourd'hui.

**Le seuil** `high` est une constante d'adaptateur avec une valeur de départ écrite avant mesure — 0,80 — et un commentaire qui renvoie au ticket 06 ; ni variable d'environnement ni réglage utilisateur.

**Le résultat** garde la forme `BrowserActResult` ; deux champs optionnels s'ajoutent : `needsRef?: true` et `candidates?: { ref, name, probability }[]`. Absents quand aucune action à `target` n'a été demandée.

## Références de conception, pas de code

`jev-use` : `none`/`abstain` réservé, ≤32 candidats par question — notre table monte à 80 et personne n'a publié l'effet du nombre d'options sur la justesse ; 06 doit le mesurer avant d'élargir ou de tronquer. `jev-ultrafast` : recheck de fraîcheur entre décision et exécution — chez nous c'est le préflight du helper, rien à ajouter. `fastbrowse` : les mots de passe ne passent jamais par un modèle — chez nous c'est déjà le cas, `value` est masqué et `text` vient de `request_secret` quand c'est un secret.

## Fichiers

- `packages/adapters/src/builtin-tools.ts` — schéma `browser_act`, description conditionnelle.
- `packages/adapters/src/browser-tools.ts` — `parseBrowserActions` (l'un de `ref`/`target`), `resolveBrowserTargets`, constante de borne, seuil.
- `packages/adapters/src/executor.ts` — passer le `DecisionProvider` résolu à `browserActFromTool` (~ligne 2733) et exposer `target` dans le schéma seulement s'il existe ; une phrase dans l'instruction système (`:850`) conditionnée de la même façon.
- `packages/adapter-kit/src/types.ts` — `BrowserActStep` gagne la variante `target`, `BrowserActResult` gagne `needsRef` et `candidates`.
- `packages/adapters/src/browser-tools.test.ts` — parsing, résolution avec le fake scripté : confiant, sous le seuil, `none`, hors table, `unavailable`, timeout, page qui change entre snapshot et act (ref périmé rendu, jamais retargeté), séquence de plusieurs `target`.
- `docs/computer-runtime.md` — un paragraphe dans la section page browser : `target` existe quand un fournisseur de décision est connecté, ce qu'il fait, ce qu'il ne fait jamais.

## Vérification

Offline, vitest, `FakeBrowserProvider` avec pages seedées et `FakeDecisionProvider` scripté. Le test pivot : une page de 80 éléments dont trois ont des noms voisins (« Télécharger », « Télécharger CSV », « Télécharger tout ») ; scripté confiant → un seul `act` avec le bon ref ; scripté 0,55 → aucun `act`, `needsRef` avec trois `candidates`. Et le test de non-régression : sans fournisseur, `browser_act` à `ref` est byte-à-byte identique à aujourd'hui.

## Ce qui reste ouvert

- `type` (ajout de texte) et `fill` avec `target` : même résolution, mais l'échec d'un `fill` sur un élément non remplissable est déjà une erreur du helper. Rien de spécial, à confirmer par un test.
- Faut-il envoyer le texte de page dans le `state` quand la description de cible est relative au contenu (« le lien de l'article sur… ») ? Non en v1 : ça ramène le coût qu'on enlève. Si 06 montre des `none` fréquents sur des pages de listes, une variante bornée (2 000 caractères autour des éléments) pourra être testée.
- Le `state` de cette question part au destinataire de 07 : noms d'éléments, valeurs de champs non secrets, URL et titre. Moins que le snapshot complet, mais des données de page quand même.

**Blocked by:** 02 (03 pour un fournisseur réel ; le ticket se livre et se teste sur le fake)

**Status:** ready-for-agent

- [ ] `browser_act` accepte `ref` ou `target`, jamais les deux, jamais aucun ; le schéma n'expose `target` que si un fournisseur est présent au run
- [ ] Une réponse hors table ou `none` n'exécute rien et rend `needsRef` avec un snapshot frais
- [ ] Une confiance sous le seuil n'exécute rien et rend les trois meilleurs candidats avec leurs probabilités
- [ ] Un ref choisi puis devenu périmé est rejeté par le chemin existant, sans retargeting, et le test l'affirme
- [ ] `unavailable` (aucun provider, timeout, erreur) rend le tour d'aujourd'hui ; un run sans provider est strictement inchangé
- [ ] `text` vient toujours du modèle ; aucun chemin ne demande une valeur au fournisseur de décision
- [ ] Le `state` passe par `redactSecrets` et ne contient jamais une valeur de champ mot de passe
- [ ] Une action à `target` qui échoue rapporte `completed` et n'est jamais rejouée par le backend
- [ ] `docs/computer-runtime.md` décrit `target` en une phrase ; entrée CHANGELOG (comportement observable par l'utilisateur : le bot clique sans relire la page)
