# 05: Vérification post-action `landed / dialog / error / auth / unchanged`

**What to build:** Après un `browser_act` dont une action à `target` a été exécutée, le résultat dit ce que l'action a produit — la page a changé comme attendu (`landed`), un dialogue ou une modale s'est ouvert (`dialog`), une erreur est apparue (`error`), un mur d'authentification ou une vérification anti-bot bloque (`auth`), ou rien de visible n'a changé (`unchanged`) — avec la probabilité de cette classe. Le modèle lit un champ au lieu de comparer deux listes d'éléments. Consultatif : le backend n'agit jamais dessus.

**Historique.** Différé au ticket 01 pour que 08 mesure 04 seul. Le mainteneur lève le report le 2026-09-26 : 05 est le prochain ticket. La mesure de 04 reste attribuable par les logs (voir « Logs »).

## Point d'accroche, dans le code livré

Tout se passe dans `packages/adapters/src/browser-tools.ts`, dans `actWithTargets`, après la boucle des actions à `target` et avant le `return` final. À cet endroit on a déjà :

- **`before`** : le `BrowserSnapshotResult` que `resolveBrowserTarget` a pris pour résoudre la **dernière** action à `target` exécutée (aujourd'hui local à la fonction : la faire rendre `{ ref, snapshot, element }` au lieu de `{ ref }`).
- **`after`** : `last`, le `BrowserActResult` de `browser.act` pour cette action. Le helper (`rakazo-page-browser`, `act`) et la session en process (`page-browser-session.ts`, `act`) rendent tous deux `url`, `title`, `tree`, `elements` d'après en cas de succès.
- **`action`** : `kind` et l'élément choisi (`role`, `name`).
- `targets.provider`, `targets.secrets`, `targets.stats`, `context`.

Aucun appel helper supplémentaire, un appel fournisseur.

## Portée : actions à `target` seulement

Décision, la plus petite : on ne vérifie que les appels où au moins une action à `target` a été exécutée, une fois par appel, sur la dernière. Pas les appels à `ref` seuls.

- `before` n'existe gratuitement que là. Pour un `ref`, il faudrait que l'exécuteur retienne le dernier snapshot par ordinateur (état de plus, périmé dès qu'un outil de bureau touche l'écran) — c'est exactement ce que le ticket 01 voulait éviter.
- Pour une action à `ref`, le modèle vient de lire la page et reçoit déjà le snapshot d'après ; c'est pour `target`, où il n'a rien lu, que la ligne vaut quelque chose.
- Une vérification par action à `target` multiplierait les appels (jusqu'à 6) ; la dernière suffit, les précédentes ont déjà été suivies d'un snapshot frais.

On ne vérifie pas quand : aucun fournisseur (`targets` absent), le dernier `act` a échoué (`ok: false`, dont `uncertain: true` : on ne classe pas l'issue d'une action dont on ne sait pas si elle a eu lieu), `after.elements` est absent, ou la résolution a rendu `needsRef`.

## L'état envoyé

Borné, structuré, **sans texte de page et sans valeur de champ**, tout passé par `redactSecrets(…, targets.secrets)` :

```ts
state = {
  action: { kind, role, name },                 // name ≤ 120
  before: { url, title, elements: number },
  after:  { url, title, elements: number },
  added:   string[],                            // `role "name"` présents après, pas avant ; ≤ 20, name ≤ 120
  removed: string[],                            // présents avant, plus après ; ≤ 20
}
```

- `added`/`removed` se calculent par multiensemble de `role "name"`, jamais par `ref` (le helper régénère tous les refs à chaque snapshot).
- Tous les rôles comptent, boutons compris : une modale se voit à ses boutons « Fermer » / « Accepter », une page de connexion à ses champs « Mot de passe » et son bouton « Se connecter ».
- Pas de `tree` : il commence par l'`innerText` de la page chez le helper (≤ 12 000 caractères) et contient les `value=` des champs ; la session en process n'a pas de texte du tout, donc un état fondé dessus ne serait pas testable pareil. Conséquence assumée : une erreur en texte seul (« Mot de passe incorrect » hors de tout contrôle) peut sortir en `unchanged`. 06 mesure cette perte ; y remédier demanderait un champ texte borné rendu par le helper, hors de ce ticket.
- Constantes nommées à côté des autres : `MAX_OUTCOME_DIFF = 20`, réutiliser `MAX_OPTION_NAME_CHARS`.

## La question

Un seul appel, une seule question :

```ts
outcome: choice("What did the action produce?", {
  landed:    "the page changed as the action intended",
  dialog:    "a dialog, modal, or popup opened",
  error:     "an error or validation message appeared",
  auth:      "the page asks to sign in, solve a challenge, or prove the user is human",
  unchanged: "nothing visible changed",
})
```

Pas de `noul` `blocked` en plus (texte historique) : une seconde question sans chiffres pour la justifier. 06 dira si `auth` a besoin d'une lecture indépendante.

Même règle que 04 : on lit `probabilities[choice]`, pas `confidence` (journalisée seulement). Sous `OUTCOME_PROBABILITY_LOW = 0.5` (valeur de départ, renvoi à 06), `kind: "uncertain"`. Délai `OUTCOME_DECISION_TIMEOUT_MS = 1_000`. `unavailable` → pas d'`outcome`, jamais un défaut inventé ; `aborted` → relancer l'abandon du run comme la résolution de cible.

## Le résultat

`BrowserActToolResult` (type local de `browser-tools.ts`, comme `needsRef`) gagne `outcome?: { kind: "landed" | "dialog" | "error" | "auth" | "unchanged" | "uncertain"; probability: number }`, présent seulement quand le fournisseur a répondu. Rien d'autre ne change dans le résultat.

**Jamais de rejeu** (`docs/computer-runtime.md`, `NON-GOALS.md`) : pas de nouvel `act`, pas de relance sur `unchanged` ou `error`, pas de `request_takeover` automatique sur `auth`. Le modèle décide. La description d'outil ajoutée par `withBrowserTargets` (`builtin-tools.ts`, `BROWSER_TARGET_DESCRIPTION`) gagne une phrase : « A result may include outcome; on auth, request takeover instead of retrying; on unchanged, inspect before acting again. » Pas de phrase dans l'instruction système : 04 n'en a pas ajouté non plus.

## Données et divulgation

Nouveau par rapport à 04 : les noms de **tous** les contrôles ajoutés ou retirés (boutons compris) partent au fournisseur. La divulgation doit rester vraie, sans avancer `AI_DISCLOSURE_VERSION` (décision du mainteneur) :

- `packages/contracts/src/ai-consent.ts`, `AI_DATA_DISCLOSURES.decision` : dire « the names of controls on them » au lieu de « links, tabs, and text fields », et « to choose which element to act on and to check what an action did ». Mettre à jour les tests qui figent ce texte s'il y en a.
- `docs/computer-runtime.md` : le paragraphe `target` dit aujourd'hui « the role and name of each offered element … never field values or page text » ; ajouter la vérification et ce qu'elle envoie. La phrase « A failed action reports confirmed progress… » gagne : « and, when a decision provider is connected, a target action's result may carry a classified outcome to read before continuing ».
- `docs/ai-data-sharing-review.md` (porte de release) et `docs/self-host.md` : une demi-phrase chacun.

## Logs (pour 08)

- `decideWithin` prend une option `purpose?: "target" | "verify"` (log seulement), reprise dans `agent.decision.call`. La résolution de cible passe `"target"`.
- Nouvelle ligne `agent.browser.outcome` : `runId`, `botId`, `kind` (de l'action), `outcome` (classe, `uncertain` ou raison `unavailable`), `probability`, `confidence`, `options: 5`. Jamais de nom d'élément, d'URL ni de fragment d'état.
- `BrowserTargetStats` gagne `verifyCalls` et `verifyAnswered`, émis dans `agent.run.decision` ; la condition d'émission de cette ligne reste celle d'aujourd'hui.

Ainsi les appels `purpose = target` et les compteurs `decision*` mesurent 04 seul, et le coût/latence de 05 se lit à part. La comparaison de tours et de tokens du modèle principal, elle, devient moins attribuable dès que 05 est livré (le modèle lit `outcome`) : 08 la lit de préférence sur les jours d'avant.

## Fichiers

- `packages/adapters/src/browser-tools.ts` — `resolveBrowserTarget` rend aussi `snapshot` et l'élément ; `verifyBrowserOutcome(before, after, action, targets, context)` ; construction de l'état ; seuil ; log ; champ `outcome`.
- `packages/adapters/src/decision.ts` — option `purpose` dans `decideWithin` et le log.
- `packages/adapters/src/builtin-tools.ts` — une phrase dans `BROWSER_TARGET_DESCRIPTION`.
- `packages/adapters/src/executor.ts` — compteurs `verify*` dans `agent.run.decision`.
- `packages/contracts/src/ai-consent.ts` — texte de divulgation.
- `docs/computer-runtime.md`, `docs/ai-data-sharing-review.md`, `docs/self-host.md`.
- `CHANGELOG.md` — une entrée `#### Changed` du jour de livraison : un bot qui agit sur un élément décrit dit ensuite si la page a changé, ouvert un dialogue, affiché une erreur ou demandé une connexion (web, desktop, mobile : c'est côté serveur).

## Tests (frontière propriétaire : `browserActFromTool`)

Dans `packages/adapters/src/browser-targets.test.ts`, avec `FakeDecisionProvider` scripté (premier pas : la cible ; second : l'issue). La session en process **ne navigue pas** sur un clic de lien vers une autre URL (elle lève, `page-browser-session.ts`) et n'exécute pas de script : les paires avant/après se fabriquent en sous-classant `FakeBrowserProvider` (comme `CountingBrowser`) pour que `act` rende un snapshot d'après seedé.

- Les cinq classes : une paire avant/après par classe, l'`outcome` rendu porte la classe et la probabilité.
- Sous 0,5 → `uncertain`.
- `unavailable` (erreur, délai, hors table) → pas d'`outcome`, résultat sinon identique.
- `act` en échec ou `uncertain: true` → aucun appel de vérification (`provider.calls.length === 1`).
- Appel à `ref` seul, ou sans fournisseur → aucun appel, résultat strictement inchangé (le test existant sans fournisseur passe sans modification).
- Plusieurs `target` → une seule vérification, sur la dernière.
- Forme de l'état : bornes (`added`/`removed` ≤ 20, noms ≤ 120), secrets redigés, aucune `value`, pas de `tree`.
- Le vérificateur n'émet jamais d'`act` supplémentaire (`browser.acts.length`).
- Logs : `purpose` présent, aucun marqueur de contenu dans les lignes émises.
- Un test de contrat si la divulgation est figée quelque part.

## Ce qui reste ouvert

- La classe `error` sans texte de page : attendre les chiffres de 06 avant d'élargir l'état.
- Une classe `challenge` séparée d'`auth` : même réponse.
- Latence : une requête de plus par `browser_act` à `target` (budget 1 s) ; 08 la lit dans `agent.decision.call` (`purpose = verify`).

**Blocked by:** 02, 04 (livrés)

**Status:** ready-for-agent

- [ ] `outcome` n'apparaît qu'après une action à `target` exécutée avec succès et une réponse du fournisseur ; jamais inventé
- [ ] `act` en échec ou `uncertain` empêche toute vérification
- [ ] Une seule vérification par appel, sur la dernière action à `target`
- [ ] Sous `OUTCOME_PROBABILITY_LOW`, `outcome.kind` vaut `uncertain` avec la probabilité
- [ ] Aucun chemin ne rejoue, ne relance ni ne déclenche `request_takeover` ; aucun `act` émis par le vérificateur
- [ ] L'état est borné (constantes nommées), redigé, sans texte de page, sans `tree`, sans valeur de champ
- [ ] Sans fournisseur ou pour un appel à `ref` seul, `browser_act` est strictement inchangé
- [ ] `agent.decision.call` porte `purpose` ; `agent.browser.outcome` et les compteurs `verify*` sont émis sans contenu
- [ ] Divulgation `decision` et docs mises à jour, `AI_DISCLOSURE_VERSION` inchangée ; entrée CHANGELOG
