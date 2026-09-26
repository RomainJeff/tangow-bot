# 09: `browser_run` — une sous-tâche de page pilotée par Jev

**What to build:** Un outil `browser_run(goal, values?, maxSteps?)` exposé seulement quand l'espace a un fournisseur de décision. Le modèle principal délègue une sous-tâche de page (remplir une recherche, poser des filtres, ouvrir un résultat) ; une boucle backend bornée fait choisir par Jev l'opération et la cible à chaque pas, prend les valeurs de texte dans `values`, et rend la main au modèle seulement pour une valeur manquante, une action à effet, un blocage ou la fin. Rouvre le non-objectif « Une boucle autonome `browser_run(goal)` pilotée par Jev » (`NON-GOALS.md`), décision du mainteneur du 2026-09-26.

## 1. Ce que fait `jev-ultrafast`, et pourquoi `target` n'a servi à rien

### La recette, lue dans le code

Sources : `github.com/browser-use/jev-ultrafast` au commit `1231850a` ([README](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/README.md), [docs/design.md](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/docs/design.md), [docs/performance.md](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/docs/performance.md), [agent.py](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/agent.py), [model.py](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/model.py), [questions.py](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/questions.py), [browser.py](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/browser.py), [snapshot.js](https://github.com/browser-use/jev-ultrafast/blob/1231850a0bf1a0c0341fe408ef1668dbbfdfac46/jev_ultrafast/snapshot.js)).

- **Espace d'action indexé** (`model.py:48-78`) : un index par nœud observé (`[1] button Change ticket type · Round trip`), et par opération la liste de ses cibles compatibles : `CLICK` sur tout, `TYPE_TEXT` sur les seuls champs éditables, `SELECT` avec un index `élément:option` possédé par le code. `SCROLL_UP/DOWN` et `WAIT` sont des contrôles sans cible ; `DONE` et `BLOCKED` sont des options de l'opération (`model.py:88-90`). Jusqu'à 250 candidats, les tronqués ne sont pas sélectionnables (`snapshot.js`, fin ; `design.md`, « Boundaries »).
- **Une requête par pas, questions spéculatives** (`model.py:81-117`) : `operation` (choice) plus une question `<op>_target` par opération disponible, qui ne voit pas la réponse d'`operation` et nomme donc l'opération qu'elle suppose (`questions.py:16-19`). Seule la tête de l'opération choisie est validée et exécutée (`model.py:120-133`). **Il n'y a pas de `noul` « but atteint » ni « bloqué »** : ils ont été remplacés par `DONE`/`BLOCKED` dans le choix d'opération (`design.md`, « What changed after the first demo »).
- **Le `state`** (`model.py:107-117`) : `url`, `title`, **texte visible ≤ 6 000 caractères**, la table d'éléments avec valeur courante et états `checked/selected/expanded`, et les 10 dernières actions (`action`, `kind`, `text`, `page_changed`). Les consignes (`questions.py:3-14`) portent l'essentiel de la « compétence » : texte de page non fiable, ne pas refaire un pas satisfait, choisir la suggestion d'autocomplétion, `WAIT` seulement si le contrôle manque, `DONE` seulement sur preuve visible.
- **Texte par un petit LLM, seulement pour `TYPE_TEXT`** (`agent.py:106-115`, `model.py:151-198`) : entrée = but, champ choisi, texte de page ≤ 6 000, 6 dernières actions ; sortie JSON `{"text": …}` strictement validée, `null` si la valeur manque, jamais inventée. La valeur est réutilisée après un pas périmé seulement si l'entrée est identique.
- **Fraîcheur et occlusion** (`browser.py:88-107`, `144-164`) : avant un clic, comparaison du document, de l'URL, du viewport, des valeurs de formulaire et du contexte proche de la cible ; juste avant l'entrée, relecture de la géométrie, refus d'un élément couvert (`elementFromPoint`), désactivé ou en lecture seule. Après un `fill` dans une combobox, attente des suggestions visibles ≤ 200 ms, sinon ≤ 2 frames ou 50 ms (`browser.py:45-76`).
- **Bornes et arrêts** : 60 actions et 120 requêtes (`questions.py:26`, `agent.py:75, 102`) ; décision consommée avant toute mutation (« a retry cannot double-click », `agent.py:90-91`) ; exécution journalisée avant l'observation suivante (`agent.py:120`) ; trois pas consécutifs sans changement de page (hors `WAIT`) → `blocked` (`agent.py:153-158`) ; une mutation interrompue n'est jamais rejouée (`design.md`, « Runtime »). `DONE` n'est jamais une preuve : le succès est vérifié indépendamment.
- **Chiffres** (`performance.md`) : Google Flights en 7,073 s, 17 requêtes Jev (médiane 178 ms), 10 interactions + 1 `WAIT`, 2 appels de texte ; 90 558 tokens d'entrée Jev sur 17 requêtes (~5 300 par pas, soit ~0,004 $ à 0,042 $/Mtok). Comparaison appariée : 3 paires, 3/3 de chaque côté, médiane 9,45 → 7,09 s, p = 0,25 — « not a broad agent benchmark ».

Les deux autres harnais ajoutent ce qui manque à `jev-ultrafast` :

- **`chy4pro/jev-for-chrome`** (`c792c616`, [`src/background/agent.ts`](https://github.com/chy4pro/jev-for-chrome/blob/c792c61679631be67131bdc1bbb43bc2f60780bb/src/background/agent.ts)) : même contrôle 3× dans les 6 dernières actions → `BLOCKED` (`agent.ts:81-83`, `400-404`) ; au 2e, les cibles portant la même opération et le même libellé sont retirées du choix (`411-416`) ; deux `noul` indépendants `goal_done` et `stuck` (`src/shared/action-space.ts:124-125`) **opposent un veto** à un `DONE` ou `BLOCKED` contredit (`agent.ts:465-478`) ; 30 pas par défaut (`src/shared/types.ts:82`) ; mots de passe exclus du snapshot (`src/content/snapshot.ts:101`).
- **`jkudish/jev-browser`** (`7b9adab7`, [`src/questions.ts`](https://github.com/jkudish/jev-browser/blob/7b9adab7f7535e93d5d1f93b00cc7f46d594fbc1/src/questions.ts)) : trois jugements parallèles par pas, `action` + `goal_done` + `stuck` (`questions.ts:14-27`) ; `goal_done > 0,85` ou `stuck > 0,85` après le pas 2 arrêtent **avant** d'exécuter l'action proposée (`src/navigate.ts:798-806`) ; mot de passe seulement par une action `fill_password` dédiée, sur une origine de confiance exacte, jamais vu du modèle (`navigate.ts:59, 476-483`).

### Pourquoi `target` n'a pas été utilisé en production

Le mainteneur observe que le modèle clique toujours par `ref`. Le code l'explique :

1. **Le modèle a toujours déjà lu la page.** `browser_navigate` ne rend que l'URL et le titre (`computer-browser.ts:70-91`) ; le seul moyen de voir la page est `browser_snapshot`, et chaque `browser_act` rend le snapshot d'après (`BrowserActResult.tree/elements`, `packages/adapter-kit/src/types.ts:819-831` ; helper `rakazo-page-browser:603`). Au moment de décider du clic suivant, les refs sont déjà dans son contexte : écrire une description plutôt qu'un ref ne lui économise rien.
2. **La lecture ne sert pas qu'à viser, elle sert à décider quoi faire.** Le modèle doit lire le texte de page pour planifier le pas suivant ; `target` supprime le coût du *ciblage*, qui est nul, pas celui de la *lecture*, qui est tout. La prémisse du README (« le modèle principal n'a plus à lire la page pour cliquer ») était fausse dès que la boucle garde un tour de modèle par pas.
3. Jusqu'à `9f36c00c`, les boutons étaient exclus des cibles ; un parcours fait de boutons ne sollicitait jamais le fournisseur.

Conséquence : le gain n'existe que si le modèle délègue **plusieurs pas** d'un coup et ne relit la page qu'à la fin. C'est exactement ce que fait `jev-ultrafast`, et c'est l'objet de ce ticket.

### Ce qui change dans notre conception

| | Lot 1–2 (livré) | `browser_run` |
|---|---|---|
| Qui choisit l'opération | le modèle, à chaque pas | Jev, à chaque pas |
| Lectures de page par le modèle | une par pas | une à la fin (ou à l'arrêt) |
| `state` envoyé au fournisseur | URL, titre, `role "name"` | + texte de page borné, valeurs courantes, valeurs fournies, actions récentes (question 1) |
| Texte des champs | `text` du modèle | clé de `values` choisie par Jev ; sinon retour au modèle |
| Boucle | `executor.ts`, un pas par tour | interne à un appel d'outil, sous les gardes de cet appel |

Écart assumé avec `jev-ultrafast` : **pas de second LLM de texte**. Le modèle principal connaît déjà les valeurs de la tâche (destination, dates, texte libre) ; il les passe dans `values`, et Jev choisit **la paire (champ, clé)** dans une seule question, ce qui évite l'incohérence de deux têtes indépendantes (champ « destination » avec la valeur « date »). Une valeur absente de `values` rend `needs_input` au lieu d'appeler un modèle.

## 2. Contrat proposé

Entrée :

```ts
browser_run({
  goal: string;                     // ≤ 500 caractères, condition d'arrêt incluse
  url?: string;                     // ouvre la page d'abord (même contrôle que browser_navigate)
  values?: Record<string, string>;  // ≤ 12 clés (≤ 40 car.), valeurs ≤ 500 car.
  maxSteps?: number;                // défaut 12, plafond 25
})
```

Pas de `successHint` : la condition d'arrêt s'écrit dans `goal` (« s'arrêter quand les vols sont affichés »), comme chez `jev-ultrafast`. Pas de liste `allow` en v1 (question 2).

Sortie :

```ts
{
  status: "done" | "blocked" | "needs_input" | "step_limit" | "unavailable";
  completed: number;                          // pas exécutés
  steps: Array<{ op: "click" | "fill" | "wait"; role: string; name: string; valueKey?: string; changed: boolean }>;
  url: string; title: string;
  tree?: string; elements?: BrowserSnapshotNode[];   // snapshot final, comme browser_act
  need?: { kind: "value" | "confirm"; ref: string; role: string; name: string };  // needs_input
  candidates?: Array<{ ref: string; name: string; probability: number }>;         // cible incertaine
  reason?: "no_progress" | "repeated_control" | "provider_blocked" | "low_confidence"
         | "password_field" | "uncertain" | "stale" | "time" | "fallback" | DecisionUnavailableReason;
  uncertain?: true;                           // la dernière action a pu avoir lieu
}
```

- `done` : Jev a choisi `done` et le `noul` `goal_done` ne le contredit pas.
- `needs_input` + `need.kind = "value"` : le champ à remplir n'a pas de clé dans `values` ; le modèle rappelle `browser_run` avec la valeur, ou `browser_act` sur `need.ref`.
- `needs_input` + `need.kind = "confirm"` : action à effet détectée (section 4) ; rien n'a été cliqué.
- `blocked` : Jev a dit `blocked`, ou garde anti-boucle, ou cible sous le seuil (avec `candidates`), ou action incertaine.
- `step_limit` : `maxSteps` ou budget de temps (`reason: "time"`).
- `unavailable` : fournisseur absent, en délai ou invalide **avant le premier pas**, ou page non pilotable (`fallback`) ; résultat identique à un `browser_snapshot`. Après au moins un pas, une décision indisponible donne `blocked` avec la raison.

Le snapshot final est toujours rendu : le modèle lit la page **une fois** au lieu d'une fois par pas, et c'est là que se trouve le gain. Exposition : uniquement quand `decisionProviders` résout un fournisseur, par le même drapeau que `withBrowserTargets` (`executor.ts:4843`, `builtin-tools.ts:35`).

## 3. La boucle, pas à pas

Module neuf `packages/adapters/src/browser-run.ts`, fonction pure sur `BrowserProvider` + `DecisionProvider` + `AdapterContext`, sans Prisma.

0. **Avant chaque pas** : `context.signal.throwIfAborted()` ; échéance (défaut 60 s, plafond 90 s) ; `completed < maxSteps` ; appels de décision `< 2 × maxSteps` (règle `jev-ultrafast`).
1. **Observer** : le premier `browser.snapshot`, puis le snapshot que rend chaque `act` (`types.ts:819-831`) — un seul appel au helper par pas. `fallback` → arrêt `unavailable`/`blocked`.
2. **Construire le `state`** (tout passe par `redactSecrets(…, runSecrets)`) : `{ goal, page: { url, title, text }, elements, values, recent }`.
   - `text` : la partie texte de `tree` (avant la table), tronquée à 4 000 caractères (question 1). `jev-ultrafast` envoie 6 000 ; la doc Jev prévient que la justesse baisse avec le contenu hors sujet (ticket 01, « Faits résolus »).
   - `elements` : `ref`, `role`, `name` ≤ 120, `value` ≤ 120 (jamais pour un mot de passe).
   - `recent` : les 6 derniers pas `{ op, name, valueKey, changed }`.
3. **Une requête Jev** (`decideWithin`, `purpose: "step"`, délai 1 500 ms — `state` plus gros que pour `target`) :
   - `operation` (choice) : `click`, `fill`, `wait`, `done`, `blocked`, restreint aux opérations qui ont des candidats ; `wait` retiré après 2 attentes consécutives ; `done`/`blocked` retirés une fois après un veto.
   - `click_target` (choice, spéculatif) : rôles `link`, `tab`, `button`, `checkbox`, `radio`, `menuitem`, `option`, `switch` (tous ceux que le helper produit, `rakazo-page-browser:360-376, 389-403`), ≤ min(80, `maxOptions` − 1), plus `none`.
   - `fill_target` (choice, spéculatif) : options `ref|clé` pour chaque champ `textbox`/`searchbox`/`combobox` × chaque clé de `values`, plus `ref|?` (« ce champ, mais aucune valeur fournie ne convient »), plus `none`. Bornes : 18 champs × (12 + 1) = 234 ≤ 255 (`maxOptions`, ticket 03). Les consignes reprennent `questions.py:16-19` : ne pas choisir un champ qui contient déjà la valeur demandée.
   - `goal_done` (noul) : contre-vérification indépendante de `done` (`jev-for-chrome`).
   - Validation : `decideWithin` valide aujourd'hui **toutes** les questions (`decision.ts:169-180`) ; une tête spéculative mal formée invaliderait le pas. Ajouter `DecideOptions.optional?: string[]` : une réponse invalide à une question optionnelle est ignorée, jamais utilisée. `operation` et `goal_done` restent obligatoires.
4. **Portes** :
   - `done` : accepté si `goal_done ≥ 0,5` ; sinon veto une fois (option retirée au pas suivant), accepté au second `done`.
   - `blocked` : arrêt `blocked`, `reason: "provider_blocked"`.
   - `click` : la cible choisie doit atteindre `TARGET_PROBABILITY_HIGH` (0,80, `browser-tools.ts:33`) ; sinon arrêt `blocked`, `low_confidence`, trois `candidates` (même forme que `needsRef`). `none` → `blocked`.
   - `fill` : paire `ref|clé` ≥ 0,80 → texte = `values[clé]`. Paire `ref|?` ou clé sous le seuil → `needs_input`, `need.kind = "value"`. Un champ mot de passe n'est jamais offert : dans le snapshot actuel, c'est un `input` sans `value` (`rakazo-page-browser:438`) ; PR 3 rend ce signal explicite. Si le but l'exige, Jev n'a que `blocked` → le modèle passe par `request_takeover`, comme aujourd'hui.
   - Action à effet : section 4, avant d'agir.
5. **Agir** : `browser.act({ actions: [une seule étape] })`. Pour un `select` natif, `fill` avec le libellé (`rakazo-page-browser:477-487`, `c4e2fefc`). `wait` : 500 ms abortables puis `snapshot`, sans appel au helper pour l'attente. Après un `fill` dans une `combobox`, 250 ms puis `snapshot` avant la décision suivante, pour ne pas choisir sur une liste d'autocomplétion vide (`browser.py:45-76`).
   - `ok: false, uncertain: true` → arrêt `blocked`, `uncertain: true`. **Jamais de rejeu** (`docs/computer-runtime.md:36`).
   - Ref périmé (`ok: false` sans `uncertain`) → nouveau snapshot ; 2 de suite → `blocked`, `stale`.
6. **Vérifier, sans appel de décision** : `changed` = URL, titre ou multiensemble `role "name"` différent (réutiliser `multisetDiff`, `browser-tools.ts:495`). Gardes anti-boucle : 3 pas non-`wait` consécutifs sans changement → `no_progress` (`agent.py:153-158`) ; même `(op, role, name)` 3 fois dans les 6 derniers pas → `repeated_control` (`jev-for-chrome`). Au 2e, retirer la cible répétée du choix suivant.

**Pas de commande `scroll`.** Le snapshot du helper n'est pas borné au viewport : il parcourt `body *` dans l'ordre du DOM jusqu'à 80 éléments (`rakazo-page-browser:430-443`), et `el.click()` agit hors écran. Défiler ne ferait apparaître aucun nouvel élément ; la vraie limite est la borne de 80 dans l'ordre du DOM, à rouvrir avec des chiffres (ordre viewport d'abord). **`wait` est backend**, pas une commande du helper.

**Pas de second LLM.** Précédent existant, s'il fallait un jour : `runAutoReviewJudge` appelle un modèle par `deps.runtime.run` avec la clé résolue pour le run (`auto-review.ts:215-260`, `executor.ts:2180-2215`). Non retenu en v1 (question 3) : le modèle principal est déjà là et `needs_input` lui coûte un tour, pas une configuration de plus.

## 4. Sûreté et intégration à l'exécuteur

L'objection du non-objectif était « une seconde boucle devrait ré-implémenter approbations, baux, garde anti-boucle, checkpoint et prise de contrôle ». Vérifié dans le code, elle tombe si `browser_run` est **un appel d'outil comme les autres** et que la boucle interne ne fait que ce qu'un `browser_act` peut faire :

- **Branche d'exécution** : ajouter `browser_run` à `PAGE_BROWSER_TOOL_NAMES` (`executor.ts:4846-4850`). Il hérite alors de la vérification `pageBrowserAllowed` (`executor.ts:1922`), du refus sous `heldForTakeover` et pendant un apprentissage (`executor.ts:2770-2779`), de `workspaceCheckpoint.markDirty()` (`executor.ts:2780`) et de `computerScreenToolResult` (`executor.ts:4681-4687`).
- **Bail d'écran et annulation** : le battement de 60 s renouvelle bail de run et bail d'ordinateur et abandonne le signal s'il est perdu (`executor.ts:1244-1259`) ; chaque commande du helper repasse par les vérifications d'écran géré et de bail du sandbox (`docs/computer-runtime.md:32`). La boucle vérifie le signal entre chaque phase ; un `decideWithin` `aborted` relance l'annulation (comme `browser-tools.ts:349`), jamais converti en `blocked`.
- **Effet et non-rejeu** : `browser_run` n'est pas dans `READ_ONLY_AGENT_TOOLS` (`executor.ts:342-357`), donc **un** `ExternalEffect` par appel (`recordEffect`, `executor.ts:2168`, `5356`) ; son résultat (liste des pas) est persisté par `finish` (`executor.ts:2420-2421`). Un run repris trouve l'effet `executing` → `uncertain`, jamais relancé (`approval-effect.ts:354-355`). Le contrat de non-rejeu s'applique donc à la granularité de l'appel ; les pas internes ne sont pas des effets séparés, ce qui est voulu : on ne rejoue pas un demi-parcours.
- **Approbation** : ajouter `browser_run` à `APPROVAL_EXEMPT_TOOLS` (`packages/core/src/action-approval.ts:3-23`), comme `browser_act`. Il ne peut rien faire de plus que `browser_act`, qui est déjà exempté — *à condition* de s'arrêter avant une action à effet :
- **Règle d'action à effet (proposée)** : avant tout `click` sur un `button`, un `link` ou un `menuitem`, deux gardes, qui ne peuvent **qu'ajouter** un arrêt :
  1. mots-clés sur le nom, fr/en, insensible à la casse et aux accents : `pay|payer|paiement|acheter|achat|buy|purchase|commander|order|checkout|réserver|book|confirmer|confirm|supprimer|delete|remove|envoyer|send|publier|publish|post|s'abonner|subscribe|signer|sign|virement|transfer|valider (la|ma) commande|place order` ;
  2. un `noul` `consequential` dans une seconde requête, posée **seulement** quand la cible est un bouton ou un lien non attrapé par (1), `state` = but + cible + contexte proche : « cliquer ceci paie, supprime, envoie ou soumet définitivement ? » ; arrêt si ≥ 0,3 (seuil bas : une erreur coûte un tour, pas un achat). Indisponible → pas d'arrêt de ce chef, (1) reste la garde.
  Arrêt = `needs_input`, `need.kind = "confirm"`, rien de cliqué. Le modèle clique lui-même avec `browser_act` sur `need.ref` : exactement le chemin d'aujourd'hui. Ce n'est **pas** un gate d'approbation par Jev (non-objectif maintenu) : Jev ne peut jamais laisser passer une action, seulement en arrêter une de plus.
- **Garde anti-boucle** : la garde du modèle principal compte les appels identiques (6, `tool-loop.ts:4`, `executor.ts:4197`) et s'applique à `browser_run` ; la boucle interne a ses propres gardes (section 3.6) et ses bornes de pas, de temps et d'appels.
- **Rédaction** : `redactSecrets` sur `goal`, `values`, texte, noms et valeurs avant tout `state`, comme `targetRequest` (`browser-tools.ts:515-543`) ; les journaux n'ont ni but, ni valeur, ni nom d'élément.
- **Langfuse** : un span d'outil `browser_run`, et sous lui une génération par appel de décision grâce au `ToolCallTrace` déjà passé à l'outil (`packages/adapter-kit/src/types.ts:447-465`, `decision.ts:76`) : `decision step` avec métadonnées `step`, `operation`, `gate`, `chosenProbability`, et `decision consequential` quand elle a lieu. `DecisionPurpose` (`decision.ts:25`) gagne `step` et `consequential`.

## 5. Mesure

Réutiliser les lignes du ticket 08, en ajouter une, ne rien mettre en base.

- `agent.decision.call` : inchangé, `purpose` `step` ou `consequential`.
- **Nouveau** `agent.browser.run`, par appel : `runId`, `botId`, `status`, `reason`, `needKind`, `steps`, `decisionCalls`, `decisionAnswered`, `vetoes`, `durationMs`, `inputTokens` et `cost` sommés sur les décisions. Ni but, ni valeurs, ni noms.
- `agent.run.decision` (`executor.ts:4651-4660`) : ajouter `browserRunCalls`, `browserRunSteps`, `browserRunDone`, et la condition d'émission devient « au moins une décision ».
- **Comparaison avec la boucle par ref**, par run : tours du modèle principal = nombre de lignes `agent.run.usage` (`executor.ts:4324`) ; tokens d'entrée du modèle = leur somme ; durée du run ; nombre d'appels `browser_*`. Succès : part des `browser_run` `done` **non suivis** d'un `browser_act`/`browser_snapshot` dans les deux tours suivants (proxy : le modèle n'a pas eu à refaire). A/B par espace sur un même déploiement, comme le prévoit 08.
- **Hors ligne, avant la production** : 4 à 6 pages fixtures jsdom (recherche + autocomplétion, filtres par cases, `select` natif, parcours à boutons, page avec « Payer ») jouées par `FakeBrowserProvider` et un fournisseur scripté pour la correction ; puis un enregistrement réel manuel, clé sur stdin comme au ticket 06, succès vérifié par l'état final de la fixture et non par `done`.

Seuil de lecture, écrit avant : si les runs avec `browser_run` n'ont pas au moins **30 % de tours de modèle en moins** par tâche navigateur à succès égal, `browser_run` est retiré et le non-objectif rétabli avec les chiffres.

## 6. Questions ouvertes

1. **Envoyer le texte de page au fournisseur.** Le README et `docs/computer-runtime.md:38` promettent « jamais le texte de page ni les valeurs de champ ». Sans texte, ni `done` ni le choix d'opération ne sont possibles (`jev-ultrafast` en envoie 6 000). *Recommandation* : oui pour `browser_run` seulement, 4 000 caractères redigés, valeurs courantes ≤ 120 hors mots de passe ; `target`/`verify` gardent leur promesse ; doc mise à jour dans la même PR.
2. **Actions à effet.** Arrêt systématique (mots-clés + `noul` à 0,3) vs liste `allow` en entrée vs passer par `planActionGate`. *Recommandation* : arrêt systématique, sans `allow` en v1 ; le modèle confirme par un `browser_act` par ref, déjà exempté. Rouvrir `allow` si la mesure montre des arrêts `confirm` en série sur un même parcours.
3. **Valeurs de texte.** `values` + paires (champ, clé) et `needs_input` vs un modèle de texte appelé par l'outil (précédent `runAutoReviewJudge`). *Recommandation* : pas de LLM en v1 ; mesurer la part de `needs_input/value` avant d'en ajouter un.
4. **Sort de `target` et de la vérification sur `browser_act`.** La production montre `target` inutilisé ; `AGENTS.md` demande de retirer la flexibilité inutilisée. *Recommandation* : garder jusqu'à la première lecture de la mesure, puis retirer `target` (et `verify`, qui ne s'exécute qu'après un `target`) de `browser_act` dans une PR dédiée, en gardant leurs fonctions internes réutilisées par `browser_run`.
5. **Orienter le modèle.** Une description d'outil n'a pas suffi pour `target`. *Recommandation* : une clause dans l'instruction système des page tools (`executor.ts:889`), seulement quand un fournisseur est résolu : « For a multi-step page task (search form, filters, opening a result), call browser_run with the goal and the values you already know. » — copie modèle, pas copie utilisateur.

## 7. Plan en petites PR

Tests aux frontières propriétaires, hors ligne, `FakeBrowserProvider` (jsdom, `fake-browser.ts` / `page-browser-session.ts`) + fournisseur de décision scripté (`fake-decision.ts`). Aucune e2e desktop.

1. **Boucle** — `browser-run.ts`, `DecisionPurpose` `step`/`consequential`, `DecideOptions.optional`. Tests `browser-run.test.ts` : `done` accepté et veto `goal_done` ; paire `ref|clé` remplie avec la bonne valeur ; `ref|?` → `needs_input/value` sans action ; mot de passe jamais offert ; bouton « Payer » (mot-clé) et bouton neutre + `consequential` 0,4 → `needs_input/confirm` sans clic ; cible à 0,6 → `blocked` avec `candidates` ; `no_progress`, `repeated_control`, `step_limit`, échéance (horloge injectée) ; `act` incertain → arrêt sans rejeu ; ref périmé → nouveau snapshot ; fournisseur indisponible au premier pas → `unavailable` sans action ; tête spéculative invalide ignorée ; annulation relancée ; marqueur secret dans `values` et dans la page absent de toute requête et de tout log. Chaque test vu échouer en cassant la ligne qu'il protège.
2. **Câblage** — définition d'outil, `withBrowserRun`, `PAGE_BROWSER_TOOL_NAMES`, `APPROVAL_EXEMPT_TOOLS`, clause d'instruction (si Q5), `agent.browser.run`, compteurs de run, trace. Tests `executor-browser-run.test.ts` : exposé seulement avec fournisseur ; un seul effet par appel ; effet `executing` repris → `uncertain` sans exécution ; refus sous `heldForTakeover` ; annulation du run pendant la boucle ; générations `decision step` sous le span d'outil. Docs `docs/computer-runtime.md` (Q1), entrée CHANGELOG `#### Added`.
3. **Helper** — signal mot de passe explicite dans `BrowserSnapshotNode` ; refus d'un clic couvert (`elementFromPoint` après `scrollIntoView`) derrière un drapeau d'étape utilisé seulement par `browser_run`, pour ne pas changer `browser_act`. Tests `infra/sandboxes/computer/test_page_browser.py` et `page-browser-session.ts` pour la parité du fake.
4. **Mesure** — fixtures de la section 5 dans `packages/testkit`, commande d'enregistrement manuel (clé sur stdin), lecture A/B.
5. **Nettoyage** (après lecture, selon Q4) — retrait de `target`/`verify` de `browser_act`.

**Blocked by:** 02, 03 (livrés). Réutilise 04, 05, 08.

**Status:** needs-review — questions 1 à 5 à trancher par le mainteneur

- [ ] Questions 1 à 5 tranchées
- [x] `NON-GOALS.md` : non-objectif `browser_run` marqué rouvert
- [ ] PR 1 à 3 livrées, mesure lue avant la PR 5
