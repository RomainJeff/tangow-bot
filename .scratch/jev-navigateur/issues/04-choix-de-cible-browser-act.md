# 04: Choix de cible pour `browser_act` par `choice` sur les refs du snapshot

> **Livré (lot 1, 2026-09-26)** dans `packages/adapters/src/browser-tools.ts`, `builtin-tools.ts` (`withBrowserTargets`) et `executor.ts`, avec des écarts listés en fin de ticket — le principal : `target` est restreint par **rôle** de candidat, jamais de bouton.

**What to build:** Le modèle peut dire « clique le ~~bouton~~ lien Télécharger CSV » sans avoir lu la page. `browser_act` accepte, pour chaque action, soit `ref` (inchangé, déterministe, sans fournisseur), soit `target` : une description courte de l'élément visé. Quand `target` est présent, le backend prend un snapshot, pose au fournisseur de décision un `choice` sur les refs courants plus une option réservée `none`, exécute l'action sur le ref choisi si la confiance passe le seuil, et sinon rend les candidats au modèle, qui choisit un ref lui-même comme aujourd'hui. ~~Le modèle principal ne lit plus 12 000 caractères de page pour cliquer un bouton ; il les lit seulement quand la décision n'est pas nette.~~ *Écart : les boutons ne sont jamais proposés ; et un retour `needsRef` contient le snapshot complet (`tree`, donc le texte de page), que le modèle relit alors.*

## Pourquoi c'est le bon point d'accroche

- La table est déjà là : `BrowserSnapshotResult.elements`, chacune `{ ref, role, name, value?, tag? }`. Elle devient la map d'options du `choice`, clé = `ref`, description = `role`, `name`, `value` (omise pour les mots de passe, déjà fait par le helper). Bornée à 80 par le helper en production (`rakazo-page-browser:432`), **mais pas par le fake** : `PageBrowserSession` (`page-browser-session.ts:165`), derrière `FakeBrowserProvider`, énumère tout. `resolveBrowserTargets` borne donc lui-même à `min(80, maxOptions − 1)` (une place pour `none`) au lieu de compter sur le fournisseur navigateur, et un test du fake avec plus de 80 éléments le vérifie.
- Le fail-closed existe en deux endroits et on n'en ajoute pas un troisième : l'enveloppe du ticket 02 refuse une réponse hors map ; le préflight du helper (`rakazo-page-browser:568`) refuse un ref devenu périmé entre le snapshot et l'action. Si la page bouge entre les deux, c'est une erreur rendue au modèle avec un snapshot frais, pas un retargeting.
- `act` renvoie déjà le snapshot d'après ; le ticket 05 s'y branche sans appel supplémentaire.

## Ce qu'on change

**Le schéma de l'outil** (`packages/adapters/src/builtin-tools.ts:95`) : `ref` devient optionnel, `target` optionnel, exactement l'un des deux requis, validé dans `parseBrowserActions` (`browser-tools.ts:76`). La description de l'outil gagne une phrase, seulement quand un fournisseur est présent : le texte de l'outil est composé au run (`selectBuiltinToolsForRun`, `executor.ts:1646`), donc un déploiement sans fournisseur ne voit pas `target` du tout. Pas de copie qui explique une capacité absente.

**La résolution** (`packages/adapters/src/browser-tools.ts`, nouvelle fonction `resolveBrowserTargets`) : pour chaque action à `target`, dans l'ordre —

1. `browser.snapshot()` — un appel helper. Si `fallback`, on rend le fallback tel quel.
2. ~~`state` = `{ goal: target, page: { url, title }, elements: [{ id: ref, role, name, value }] }`.~~ *Livré : `state` = `{ url, title }` ; la cible est dans l'`instructions` ; chaque option = `role "name"` (nom tronqué à 120), sans `value`.* Pas de texte de page libre dans cet usage : la question porte sur les contrôles, et le texte est ce qui coûte. Concrètement le `state` se construit depuis `elements` et jamais depuis `tree`, qui commence par l'`innerText` de la page (≤12 000 caractères, `rakazo-page-browser:438`). Le `state` passe par `redactSecrets` (`@rakazo/core`) avec les secrets du run, comme `redactToolArgsForReview`.
3. `questions = { target: choice("Which element matches the goal? Answer none if no element does.", { ...refs, none: "no listed element matches" }) }`. Une question, un appel.
4. `decideWithin(provider, …, { timeoutMs })`. `unavailable` → on rend `{ ok: false, completed, needsRef: true, tree, elements, reason }` : le modèle reçoit le snapshot et choisit un ref, c'est-à-dire exactement le tour d'aujourd'hui avec un appel d'outil en moins.
5. Gate : ~~`confidence ≥ high`~~ probabilité de l'option choisie ≥ 0,80 → exécuter ; sinon → même retour `needsRef` avec les trois meilleurs candidats et leurs probabilités dans `candidates`, pour que le modèle tranche sans relire toute la page. `none` choisi → `needsRef` sans candidats. Pas de niveau `caution` qui exécute : une cible incertaine ne se clique pas, elle se rend.
6. Exécuter par le chemin existant : `browser.act({ actions: [{ kind, ref, text? }] })`. `text` reste celui du modèle ; Jev ne l'écrit jamais.

**Plusieurs actions dans un appel** : `MAX_BROWSER_ACTIONS = 24` reste pour les actions à `ref`. Les actions à `target` se résolvent une par une, chacune avec un snapshot frais, parce que la première change la page ; borne séparée (proposition : 6 par appel) écrite en constante à côté de l'autre. Une résolution qui rend `needsRef` arrête la séquence et rapporte `completed`, comme une action échouée aujourd'hui.

**Restriction v1 — actions réversibles seulement** (décision du ticket 01). ~~`target` refusé au parsing pour une action à effet ; liste de `kind` autorisés ; motif : `planActionGate` juge l'action.~~ *Livré : le `kind` ne dit rien de l'effet (`click` couvre lien et bouton). La restriction porte sur les candidats offerts : `TARGET_ROLES` — `click` → `link`, `tab` ; `fill`/`type` → `textbox`, `searchbox`, `combobox`. Un bouton n'est jamais une option, donc une action qui soumet, paie ou supprime exige un `ref`. Motif corrigé : `browser_act` est exempté d'approbation (`packages/core/src/action-approval.ts`, `APPROVAL_EXEMPT_TOOLS`), aucun juge ne passe derrière un mauvais clic.*

**Le seuil** `high` (`TARGET_PROBABILITY_HIGH`) est une constante d'adaptateur avec une valeur de départ écrite avant mesure — 0,80, comparée à la probabilité de l'option choisie, pas à `confidence` — et un commentaire qui renvoie au ticket 06 ; ni variable d'environnement ni réglage utilisateur.

**Le résultat** garde la forme `BrowserActResult` ; deux champs optionnels s'ajoutent : `needsRef?: true` et `candidates?: { ref, name, probability }[]` (*livré : plus `reason?` et `note?`, dans le type local `BrowserActToolResult` de `browser-tools.ts`, pas dans `adapter-kit`*). Absents quand aucune action à `target` n'a été demandée.

## Références de conception, pas de code

`jev-use` : `none`/`abstain` réservé, ≤32 candidats par question — un plafond auto-imposé sans base : la documentation officielle autorise **255 options par `choice`**, donc nos 80 refs passent sans troncature (ticket 01). Ce qui reste inconnu n'est pas la limite mais l'effet du nombre d'options sur la justesse, que 06 doit mesurer. `jev-ultrafast` : recheck de fraîcheur entre décision et exécution — chez nous c'est le préflight du helper, rien à ajouter. `fastbrowse` : les mots de passe ne passent jamais par un modèle — chez nous c'est déjà le cas, `value` est masqué et `text` vient de `request_secret` quand c'est un secret.

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

**Status:** done (lot 1, 2026-09-26)

- [x] `browser_act` accepte `ref` ou `target`, jamais les deux, jamais aucun ; le schéma n'expose `target` que si un fournisseur est résolu au run (`selectBuiltinToolsForRun({ browserTargets })`)
- [x] ~~`target` est refusé sur une action à effet~~ Aucun bouton n'est jamais proposé ; les rôles offerts dépendent du `kind` (test « offers only reversible roles for the action kind, never buttons »)
- [x] Une réponse hors table ou `none` n'exécute rien et rend `needsRef` avec un snapshot frais
- [x] Une probabilité sous le seuil n'exécute rien et rend au plus trois candidats avec leurs probabilités (`none` exclu)
- [x] Un ref choisi puis devenu périmé est rejeté par le chemin existant, sans retargeting, et le test l'affirme
- [x] `unavailable` (aucun provider, timeout, erreur, réponse invalide) rend le tour d'aujourd'hui ; un run sans provider est strictement inchangé
- [x] `text` vient toujours du modèle ; aucun chemin ne demande une valeur au fournisseur de décision
- [x] Le `state`, les options et l'instruction passent par `redactSecrets` avec les secrets du run ; aucune valeur de champ n'est envoyée
- [x] Une action à `target` qui échoue rapporte `completed` et n'est jamais rejouée par le backend
- [x] `docs/computer-runtime.md` décrit `target` ; entrée CHANGELOG du 2026-09-26

## Livré — écarts avec le texte ci-dessus

- **Candidats** : éléments du snapshot filtrés par `TARGET_ROLES[kind]`, puis bornés à `min(80, maxOptions − 1)`, plus `none`. Aucun candidat du bon rôle → `needsRef` sans appel au fournisseur (issue `returned_none`).
- **Requête** (`targetRequest`) : `state: { url, title }`, une question `target` de type `choice`, instruction `Which element matches: <target>? Answer none if no listed element does.`, options `role "name"` ; jamais `tree`, jamais `value`. Tout passe par `redactSecrets(…, runSecrets)`.
- **Gate** : exécuter si `probabilities[choice] ≥ 0,80` ; `confidence` (concentration de la distribution ; exemple documenté 0,75 pour un choix à 0,84) n'est que journalisée. `decideWithin` garantit que l'option choisie a une probabilité (`invalid_answer` sinon).
- **Séquence** : les actions à `ref` doivent précéder les actions à `target` (sinon erreur de parsing : chaque `target` prend un snapshot frais qui périme les refs suivants) ; les `ref` partent en un seul `act`, puis chaque `target` est résolu et exécuté un par un. Bornes : `MAX_BROWSER_TARGET_ACTIONS = 6`, `target` ≤ 200 caractères, délai `TARGET_DECISION_TIMEOUT_MS = 1 000`. Le premier `needsRef` arrête la séquence avec `completed`.
- **Retour `needsRef`** : `ok: false`, `url`, `title`, `tree`, `elements` du snapshot de résolution, `candidates?`, `reason?` (raison `unavailable`), `note` en anglais qui dit de choisir un ref.
- **Copie modèle** : une phrase ajoutée à la description de `browser_act` par `withBrowserTargets` (`builtin-tools.ts`), seulement quand un fournisseur est résolu. ~~Phrase dans l'instruction système (`executor.ts:850`)~~ non ajoutée.
- **Aborted** : une annulation du run pendant la décision est relancée, pas convertie en `needsRef`.
- **Tests** : `browser-targets.test.ts` (au niveau de `browserActFromTool`, noms anglais « Download / Download CSV / Download all ») et `executor-browser-targets.test.ts` (câblage du résolveur dans l'exécuteur). ~~`browser-tools.test.ts`~~. Le replay contacts avec `target` n'est pas fait (ticket 06).
- **Logs** : `agent.browser.target` par résolution, compteurs de run (ticket 08).
