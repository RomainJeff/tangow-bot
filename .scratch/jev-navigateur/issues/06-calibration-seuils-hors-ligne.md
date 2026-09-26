# 06: Calibrer les seuils hors ligne sur un corpus étiqueté

**What to build:** De quoi choisir les deux seuils du lot sur des chiffres — `TARGET_PROBABILITY_HIGH` (04, 0,80 : en dessous, on ne clique pas) et `OUTCOME_PROBABILITY_LOW` (05, 0,5 : en dessous, `uncertain`) — sans clé dans le dépôt : un corpus étiqueté de pages figées, un constructeur qui en tire les requêtes exactes que le code de production enverrait, un script d'évaluation hors ligne qui rejoue des réponses enregistrées, et une étape manuelle, documentée, pour enregistrer de vraies réponses OpenRouter. Ce ticket livre l'outillage ; **les seuils ne se tranchent qu'une fois un enregistrement réel committé**.

## Ce que le cadrage a établi (toujours vrai)

- Le replay contacts (`packages/testkit/src/fixtures/contacts-luna-docker.json`) est un scénario de six pas sur trois pages de un à trois éléments, vocabulaire clos sans refs ni snapshots (`computer-recording.ts`). Bon test de non-régression, mauvais corpus : aucun distracteur.
- La seule fixture de décision du dépôt, `packages/adapters/src/fixtures/openrouter-decision.json`, est l'exemple documenté d'OpenRouter (tri de tickets de support) : elle prouve la traduction du fil, rien sur la navigation.
- Aucun dépôt étudié ne publie de corpus navigateur rejouable offline. Il se construit à la main.

## Le corpus

Emplacement : `packages/testkit/src/fixtures/decision/cases/*.json`, un fichier par cas, sans aucune donnée réelle. Schéma clos, validé comme `parseContactsRecording` :

```ts
// cas de cible (04)
{ id, family, lang: "fr" | "en", kind: "click" | "fill" | "type",
  page: { url, title, html },            // url en https://<x>.test/ uniquement
  target: string,                         // description, dans la langue de `lang` ou croisée
  expected: { role, name } | "none" }     // étiquette par élément, jamais par ref

// cas d'issue (05)
{ id, family: "outcome", lang,
  before: { url, title, html }, after: { url, title, html },
  action: { kind, role, name },
  expected: "landed" | "dialog" | "error" | "auth" | "unchanged" }
```

Étiqueter par `{ role, name }` et pas par `ref` : les refs dépendent de la session. Le constructeur retrouve le ref.

Familles, au moins dix cas chacune, **chaque cas en français et en anglais**, plus des cas croisés (cible en français sur page anglaise et inverse) :

- **Distracteurs** : noms voisins (« Enregistrer » / « Enregistrer et fermer » / « Enregistrer comme brouillon »), même nom sur un lien et un bouton (le bouton n'est pas offert : la bonne réponse est le lien ou `none`), noms vides ou génériques (« En savoir plus » ×5).
- **Densité** : 20, 40 et 80 candidats du bon rôle, cible au rang 1, milieu et dernier ; cible hors des 80 → `none`.
- **Formulaires** (`fill`/`type`) : champs `textbox`/`searchbox`/`combobox` étiquetés par `label`, `placeholder` ou `aria-label`.
- **Aucune cible** : description qui ne correspond à rien → `none`.
- **Issues** (après 05) : les cinq classes, plus les frontières — bannière de cookies, erreur inline sans changement d'URL (attendue difficile sans texte de page, voir 05), page de connexion en français, même URL avec contenu différent.

Cible : 150 à 200 cas, dont la moitié en français. Chaque cas se relit par un humain avant commit : un cas mal étiqueté fausse un seuil.

## Le constructeur

`packages/testkit/src/decision-corpus.ts` : `loadDecisionCorpus()` (lecture + validation, refus d'une URL hors `.test`) et `buildDecisionRequests(corpus)` qui rend `{ caseId, request, expectedKey, optionCount }` par cas.

Les requêtes passent **par le chemin de production**, pas par une copie : `FakeBrowserProvider` seedé avec la page, `browserActFromTool` avec un `FakeDecisionProvider` dont le pas scripté enregistre la requête et lève (la résolution rend alors `needsRef`, sans effet). La requête lue dans `provider.calls` est exactement celle de `targetRequest` (rôles filtrés, borne 80, `none`, redaction). Pour les cas d'issue, même principe avec un navigateur sous-classé dont `act` rend le snapshot d'`after` (la session en process ne navigue pas sur un lien, `page-browser-session.ts`). `expectedKey` = ref de l'élément `{ role, name }` dans les options, ou `none`.

Limite à écrire dans le README du corpus : les noms et rôles viennent de la session jsdom (`page-browser-session.ts`), pas du helper Chrome (`rakazo-page-browser`) ; les deux calculs de nom diffèrent à la marge.

## Les enregistrements

`packages/testkit/src/fixtures/decision/recordings/<modèle>-<AAAA-MM-JJ>.json` :

```ts
{ provider: "openrouter", model, recordedAt, corpusHash,
  cases: { [caseId]: { requestHash, response?: DecisionResponse, unavailable?: reason } } }
```

`requestHash` = sha256 du JSON canonique de la requête : si le corpus ou le code de requête change, le rejeu le voit et refuse ce cas au lieu de mesurer autre chose. `response` ne contient que `answers`, `model`, `usage` (tokens, coût) : ni clé, ni en-tête, ni URL autre que `.test`.

## L'évaluation hors ligne

`packages/testkit/src/cli/decision-calibration.ts`, script racine `test:decision-calibration` (à côté de `test:computer-replay`). Par défaut, hors ligne : charge corpus et enregistrement (`--recording=<fichier>`), reconstruit les requêtes, vérifie les `requestHash`, fait passer chaque réponse par `decideWithin` via un `FakeDecisionProvider` scripté (même validation qu'en production ; une réponse invalide compte comme `unavailable`) et imprime :

- **Cible** : justesse brute du `choice`, `none` correct, par famille, par langue (fr, en, croisé) et par tranche d'options (≤ 20, ≤ 40, ≤ 80) ; pour chaque seuil de 0,50 à 0,95 par pas de 0,05, le taux d'exécution et le taux de **mauvais ref exécuté** ; erreur de calibration attendue (ECE, 10 classes) sur la probabilité de l'option choisie ; même chose sur `confidence`, pour justifier (ou non) le choix de 04 de ne pas s'en servir.
- **Issue** : justesse par classe, matrice de confusion, taux d'`uncertain` sur cas nets et sur cas frontières pour chaque seuil bas.
- Latence non mesurée (rejeu) ; coût total de l'enregistrement repris de `usage.cost`.

Tests déterministes dans `pnpm test` :

- `decision-corpus.test.ts` : chaque cas se valide, aucune URL hors `.test`, `expected` existe dans les options construites, construction déterministe.
- `decision-calibration.test.ts` : les métriques sur un petit enregistrement **synthétique** nommé comme tel (`recordings/synthetic.json`, exclu des conclusions) — il teste le calcul, pas Jev.
- Garde conditionnelle : si un enregistrement non synthétique existe, le test vérifie que les constantes exportées de `browser-tools.ts` respectent les critères ci-dessous sur cet enregistrement ; sans enregistrement réel, il est ignoré avec un message qui le dit.

## Étape manuelle : enregistrer de vraies réponses

`pnpm test:decision-calibration --record=<nouveau-fichier.json> [--model=typesafe/jev-1.13]` :

- La clé OpenRouter se lit sur **stdin** (saisie masquée si TTY, sinon première ligne du flux). Jamais une variable d'environnement : le script n'appelle pas `loadRootEnv` et ne lit ni `OPENROUTER_API_KEY` ni aucune autre. Jamais écrite sur disque, dans l'enregistrement ou dans un log.
- Utilise `OpenRouterDecisionProvider` (`packages/adapters/src/openrouter-decision.ts`) avec la base URL par défaut, en séquence, une tentative par cas, délai large (pas celui de production : on mesure la réponse, pas le budget).
- Refuse de tourner si un cas référence une URL hors `.test` ou si le fichier cible existe.
- Imprime le coût total et le nombre d'`unavailable`, puis enchaîne immédiatement le rejeu hors ligne sur le fichier produit.
- Documenté dans `docs/agent-verification.md` (une ligne de tableau et un bloc comme la capture contacts) : manuel, payant, résultat committé avec date et `model` renvoyé.

## Critères, écrits avant de regarder

- `TARGET_PROBABILITY_HIGH` = la plus petite valeur telle que le taux de mauvais ref exécuté est ≤ 1 % sur le corpus. Si aucune valeur ≤ 0,95 n'y arrive, consigner et proposer au mainteneur de retirer `target` des runs (la connexion reste pour 05) ; ne rien désactiver soi-même.
- Justesse brute ≤ 85 % sur « distracteurs » ou ≤ 80 % sur le français : consigner, rouvrir 01 avec les chiffres.
- Chute de plus de dix points entre 40 et 80 options sur les mêmes cibles : proposer une borne à 40 dans `resolveBrowserTarget`.
- `OUTCOME_PROBABILITY_LOW` = la valeur qui rend `uncertain` sur au moins 90 % des cas frontières mal classés, sans dépasser 20 % d'`uncertain` sur les cas nets.

## Ce qui ne peut pas être conclu sans enregistrement réel

Rien sur les seuils. Ni si 0,80 est trop haut ou trop bas, ni la justesse de Jev sur des pages françaises, ni l'effet du nombre d'options, ni la séparabilité de `error` sans texte de page, ni la valeur de `confidence`. Les chiffres du jeu synthétique ne disent rien de Jev. Un enregistrement vaut pour un identifiant de modèle (`typesafe/jev-1.13` aujourd'hui) et pour des pages jsdom, pas pour Chrome ; une montée de version se recalibre par un nouvel enregistrement, lu comme un diff.

## Fichiers

- `packages/testkit/src/fixtures/decision/cases/`, `recordings/`, README court (format, limite jsdom, relecture humaine).
- `packages/testkit/src/decision-corpus.ts`, `decision-corpus.test.ts`.
- `packages/testkit/src/decision-calibration.ts` (métriques), `decision-calibration.test.ts`.
- `packages/testkit/src/cli/decision-calibration.ts` ; `package.json` racine, script `test:decision-calibration`.
- `packages/adapters/src/browser-tools.ts` — exporter les deux constantes de seuil (lecture seule, pour la garde).
- `docs/agent-verification.md`.

Pas d'entrée CHANGELOG : rien d'observable par un utilisateur.

## Ce qui reste ouvert

- Qui écrit et relit 150 cas : le vrai coût du ticket. Un agent peut rédiger, un humain relit « distracteurs » et « langue ».
- Le replay contacts avec `target` au lieu de `ref` : demanderait un fournisseur de décision dans le rejeu Docker ; hors de ce ticket.

**Blocked by:** 04 (livré) ; 05 pour la famille « issues » (les cas de cible peuvent se livrer avant)

**Status:** ready-for-agent pour l'outillage hors ligne ; needs-decision pour les seuils, après un enregistrement réel

- [ ] Corpus de 150 à 200 cas, sans donnée réelle, cinq familles, parité français/anglais et cas croisés, relu par un humain
- [ ] Requêtes construites par `browserActFromTool` et les fakes, pas par une copie du code de requête
- [ ] Rejeu hors ligne qui vérifie les `requestHash` et passe par `decideWithin`
- [ ] Rapport : justesse, `none`, par famille/langue/tranche d'options, exécution et mauvais ref par seuil, ECE, issues par classe
- [ ] Enregistrement manuel avec clé lue sur stdin, jamais par variable d'environnement, jamais écrite ; refus hors `.test`
- [ ] `pnpm test` tourne sans clé ni réseau ; le jeu synthétique est marqué comme tel
- [ ] Après enregistrement réel : seuils fixés avec un commentaire qui renvoie au rapport, décision consignée (seuil, borne d'options, `target` conservé ou non)
