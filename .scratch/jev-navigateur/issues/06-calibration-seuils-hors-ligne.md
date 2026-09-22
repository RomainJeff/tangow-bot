# 06: Calibrer les seuils hors ligne sur un corpus étiqueté

**What to build:** Les deux seuils du lot — `high` (04 : en dessous, on ne clique pas) et `low` (05 : en dessous, on dit `uncertain`) — sont choisis sur des chiffres, pas sur un nombre rond, et le test qui les justifie tourne dans `pnpm test` sans clé ni réseau. Ce ticket est une décision qui demande des mesures, comme le 09 du lot `harness-context-quality`.

## Ce que le cadrage a corrigé

**Les fixtures de replay existantes ne suffisent pas à calibrer.** Le brief les désignait comme jeu étiqueté naturel. Vérifié : `packages/testkit/src/fixtures/contacts-luna-docker.json` est **un** scénario de **six** pas sur trois pages de un à trois éléments (`ContactsBrowserFixture`, `computer-replay-fixture.ts`). Le vocabulaire enregistré est clos par construction — `op`, `target` parmi trois noms, `outcome` — et exclut volontairement refs, URLs et snapshots (`parseContactsRecording`, `computer-recording.ts:45`). C'est un excellent test de non-régression du chemin bout en bout, et un mauvais corpus de calibration : trois cibles sans distracteur ne mesurent rien sur 80 options. Il reste utile pour une chose : vérifier qu'avec `target` au lieu de `ref` le replay produit le même CSV et exactement un export.

**Il faut donc un corpus, et il se construit à la main.** Les dépôts étudiés ne fournissent pas non plus de corpus navigateur étiqueté : `jevbench` couvre maths, code, droit, finance ; `fastbrowse` publie 14 tâches vivantes sur des sites réels (non figées) ; `jev-for-chrome` publie 17 traces sur sites réels. Rien de rejouable offline sur des pages figées.

## Le corpus

Des pages HTML seedées (`FakeBrowserProviderOptions.pages`), pas des sites réels, pour rester offline et sans donnée de client. Chaque cas : une page, un `target` en langage naturel, le `ref` attendu (ou `none`), et pour 05 une paire avant/après avec la classe attendue. Familles à couvrir, chacune avec au moins dix cas :

- **Distracteurs** : noms voisins (« Enregistrer » / « Enregistrer et fermer » / « Enregistrer comme brouillon »), même nom en deux rôles (lien et bouton), icônes sans nom (`name` vide ou générique).
- **Densité** : pages à 80 éléments (la borne) dont la cible est au rang 1, 40 et 79 ; pages tronquées où la cible est hors des 80 — la bonne réponse est `none`.
- **Langue** : les mêmes cas en français et en anglais, libellés de page et `target` croisés (cible en français sur page anglaise et inverse). C'est la réserve du ticket 01 ; sans ces cas, aucun seuil ne vaut pour nos utilisateurs.
- **Formulaires** : champs avec `value` pré-remplie, mot de passe masqué, cases à cocher `checked`/`unchecked`.
- **Issues** (05) : les cinq classes, plus les cas frontières — modale de cookies (dialog ou unchanged ?), erreur inline sans changement d'URL, page de connexion en français, redirection vers la même URL avec contenu différent.

Cible : 150 à 200 cas. Un cas est un fichier JSON à côté d'une page HTML sous `packages/testkit/src/fixtures/decision/`, sans aucune donnée réelle.

## La mesure

Deux modes, un seul jeu de cas :

1. **Capture** (manuel, avec clé, hors CI) : un script parcourt les cas, appelle le fournisseur réel via l'adaptateur du ticket 03 et enregistre requête et réponse figées. Les réponses ne contiennent que des probabilités et des identifiants ; rien à redacter, mais le script refuse de tourner si un cas référence une URL non locale.
2. **Rejeu** (offline, CI) : la conformité et le test de calibration rejouent les réponses figées à travers le même `fetch` injecté. Le test calcule, sur le corpus : justesse du `choice`, taux de `none` correct, et pour chaque seuil candidat le couple (taux d'exécution, taux d'erreur exécutée) pour 04, et l'erreur de calibration attendue (ECE, la méthode de `jevbench`) pour 05.

## Critères, écrits avant de regarder

- `high` est la plus petite valeur telle que le taux de **mauvais ref exécuté** sur le corpus est ≤ 1 %. Si aucune valeur ≤ 0,95 n'y arrive, `target` n'est pas activable par défaut et le ticket 04 passe derrière un réglage explicite par espace.
- Si la justesse brute du `choice` est ≤ 85 % sur la famille « distracteurs » ou ≤ 80 % sur la famille « langue » en français, on n'active pas ; on consigne et on rouvre 01 avec les chiffres.
- `low` est la valeur qui rend `uncertain` sur au moins 90 % des cas frontières mal classés, sans dépasser 20 % d'`uncertain` sur les cas nets.
- L'effet du nombre d'options : justesse à 20, 40 et 80 options sur les mêmes cibles. Si la chute entre 40 et 80 dépasse dix points, 04 tronque à 40 (les 40 premiers éléments, ordre du DOM) et le dit dans le résultat.

## Fichiers

- `packages/testkit/src/fixtures/decision/` — pages et cas.
- `packages/testkit/src/decision-corpus.ts` — chargement et validation des cas (schéma clos, comme `parseContactsRecording`).
- `packages/adapters/src/decision-calibration.test.ts` — le rejeu et les seuils, qui échoue si une valeur figée dans `browser-tools.ts` viole un critère ci-dessus.
- `scripts/capture-decision-fixtures.ts` (ou sous `packages/testkit`) — la capture avec clé, refusée sans, refusée hors pages locales.
- `packages/testkit/src/computer-recording.ts` — un mode de rejeu du scénario contacts avec `target` au lieu de `ref`, pour la non-régression bout en bout.
- `docs/agent-verification.md` — une ligne dans le tableau : « Decision calibration | fixtures figées | fournisseur réel | `pnpm test` ».

## Vérification

`pnpm test` rejoue ; le test de calibration est déterministe puisque les réponses sont figées. La capture est documentée comme manuelle et son résultat est committé avec la date et l'identifiant de modèle du fournisseur (`answers.model`), pour que la recalibration à une nouvelle version du modèle soit un diff lisible.

## Ce qui reste ouvert

- Qui écrit 150 cas ? C'est le vrai coût du ticket, et il ne se délègue pas à un modèle sans relecture : un cas mal étiqueté fausse un seuil. Prévoir une passe de relecture humaine sur les familles « distracteurs » et « langue ».
- Les réponses figées vieillissent avec le modèle du fournisseur (`jev-latest` bouge). Décider si on épingle un identifiant de modèle daté dans la connexion par défaut ou si on recapture à chaque montée de version.

**Blocked by:** 03, 04, 05

**Status:** needs-decision — les seuils se tranchent sur les chiffres du rejeu

- [ ] Corpus de 150 à 200 cas, sans donnée réelle, avec les cinq familles et la parité français/anglais
- [ ] Script de capture qui refuse de tourner sans clé et hors pages locales
- [ ] Réponses figées committées avec date et `answers.model`
- [ ] Critères ci-dessus inchangés au moment de lire les chiffres, ou la modification est consignée avec sa raison
- [ ] `high` et `low` fixés dans le code avec un commentaire qui renvoie au test de calibration
- [ ] Le test échoue si une constante viole un critère
- [ ] Décision consignée : `target` activé par défaut, derrière un réglage, ou pas activé ; borne d'options retenue
- [ ] Le replay contacts passe avec `target` et produit exactement un export
