# `browser_run` — une sous-tâche de page pilotée par un fournisseur de décision

Remplace le jeu de tickets `.scratch/jev-navigateur/` (cadrage, lots `target` et `verify`), qui reste en lecture pour l'historique.

## Quoi

Un outil `browser_run(goal, values?, maxSteps?)`, offert avec les outils de page seulement quand l'espace a un fournisseur de décision (Réglages → Navigateur, aujourd'hui l'API Decisions d'OpenRouter qui sert Jev de TypeSafe). Le modèle principal délègue une sous-tâche de page avec les valeurs qu'il connaît ; une boucle backend bornée fait choisir au fournisseur l'opération et la cible à chaque pas et rend la main pour une valeur manquante, un clic à effet, un doute, un blocage ou la fin.

## Pourquoi

Aujourd'hui une tâche de page coûte un tour de modèle par pas : `browser_snapshot` (jusqu'à 12 000 caractères de texte et 80 éléments), lecture, `browser_act` par ref. Un choix de cible par description (`target` sur `browser_act`, prototypé sur une branche puis abandonné) n'a rien changé : le modèle a toujours déjà lu la page quand il clique, et la lecture sert à décider quoi faire, pas seulement où cliquer. Le gain n'existe que si le modèle délègue plusieurs pas et ne relit la page qu'à la fin : c'est la recette de `browser-use/jev-ultrafast` (une requête Jev par pas, opération et cible dans le même appel).

## La boucle

Module `packages/adapters/src/browser-run.ts`, fonction pure sur `BrowserProvider` + `DecisionProvider`, sans Prisma.

1. Observer : un snapshot au départ, puis celui que rend chaque `act`.
2. État (après rédaction des secrets du run) : but, URL, titre, texte de page ≤ 4 000 caractères (le `tree` sans la table d'éléments), valeurs fournies (≤ 120 caractères), table d'éléments indexée avec valeurs courantes (≤ 120, jamais les mots de passe), 10 derniers pas.
3. Une requête par pas (`decideWithin`, `purpose: "run_step"`, 1,5 s) : `operation` (click, fill, select, wait, done, blocked, restreint aux opérations qui ont des candidats), et par opération une question spéculative de cible : élément cliquable pour `click`, paire (champ, clé de `values`) ou (champ, « aucune valeur fournie ») pour `fill`, et pour `select` les paires (liste, libellé d'une de ses options), (liste, clé de `values`) et (liste, « aucune valeur fournie ») seulement pour une liste sans options ; plus `goal_done` (oui/non). Seule `operation` est obligatoire : `DecideOptions.optional` écarte une réponse spéculative mal formée sans invalider le pas.
4. Portes : cible choisie ≥ 0,80, ou ≥ 0,60 et au moins le double du meilleur autre élément (hors « aucun »), sinon `blocked` avec trois candidats ; la marge vient de la production, où deux boutons d'avancement équivalents (« CONTINUER » 0,65, « Suivant » 0,30) bloquaient une étape sans ambiguïté ; paire « aucune valeur » → `needs_input` `value` ; `done` contredit par `goal_done` < 0,5 refusé une fois ; `blocked` du fournisseur → `blocked`.
5. Agir : une étape `act`, décision consommée avant (jamais rejouée). Un `select` natif passe par `fill` avec le libellé de l'option choisie ou la valeur fournie. `wait` = 500 ms puis snapshot, au plus deux de suite. Après un `fill` ou un `select` réussi, 300 ms puis snapshot : un bouton désactivé tant que le champ est vide (« CONTINUER » en production) est réactivé par le rendu qui suit ; un élément `disabled` (`:disabled` ou `aria-disabled="true"`) reste listé et marqué, jamais proposé comme cible.
6. Arrêts : trois pas sans changement de page, même contrôle une troisième fois en six pas, action incertaine ou deux échecs de suite, `maxSteps` (25 par défaut, 40 au plus), 120 s, 2 × `maxSteps` décisions, annulation du run (relancée, jamais convertie).

Pas de second LLM pour le texte : les valeurs viennent de `values`, une valeur absente rend `needs_input`.

`browser_act` reste fermé tant que `browser_run` n'a pas rendu `blocked`, `step_limit`, `unavailable`, `needs_input` `confirm` ou une erreur. Ni `done` ni `needs_input` `value` ne l'ouvrent : en production, après une valeur demandée, le modèle a fini le formulaire à la main par `browser_act` au lieu de rappeler `browser_run` avec la valeur ; le message de refus le lui dit.

## Listes déroulantes

Comme `browser-use/jev-ultrafast` (`jev_ultrafast/snapshot.js`, commit `1231850a`, lignes 68-71 : chaque option non sélectionnée et active d'un `<select>` devient une action `select` « champ → libellé », avec la valeur courante en libellés ; `jev_ultrafast/browser.py` vérifie à l'exécution que l'option existe et n'est pas désactivée avant de poser `e.value`), le fournisseur choisit parmi les options de la liste elle-même : en production, `values` n'avait pas de durée et « Durée approximative » rendait `needs_input` alors que la page proposait les durées.

- Snapshot (helper et session en mémoire, mêmes règles) : `options` sur un `<select>` seulement, libellés des options actives et affichées, rognés, ≤ 80 caractères, 30 au plus (`optionsTruncated` au-delà) ; la `value` d'un `<select>` devient le libellé choisi, jamais la valeur cachée.
- Question `select_target` : clés de `values` d'abord, puis « aucune valeur fournie » pour une liste sans options, puis les libellés de chaque liste dans l'ordre de la page, sans l'option déjà affichée. Au-delà de la limite d'options du fournisseur, la fin de cet ordre est coupée.
- Exécution : `fill` avec le libellé ; le helper apparie la valeur puis le libellé sans casse.

## Sûreté

- Avant tout clic, une garde par mots-clés fr/en sans casse ni accents (payer, acheter, commander, réserver, confirmer, supprimer, envoyer, soumettre, publier, s'abonner, signer, virement… et leurs équivalents anglais). Une question oui/non « clic à effet » posée dans le même appel a été retirée : elle ne voit pas l'élément choisi et a bloqué un bouton neutre en production. Arrêt = `needs_input` `confirm`, rien de cliqué ; le modèle confirme par `browser_act` sur le ref, chemin déjà exempté d'approbation.
- Les champs mot de passe (signal `password` du snapshot, ou valeur absente côté helper) ne sont jamais offerts et leur valeur n'entre jamais dans l'état.
- Un appel d'outil comme les autres : `PAGE_BROWSER_TOOL_NAMES` (refus sans navigateur de page, sous prise de contrôle, pendant un apprentissage ; checkpoint marqué), exempté d'approbation comme `browser_act` sauf déclencheur non surveillé, un `ExternalEffect` par appel (incertain si interrompu), bail d'écran de l'appel.

## Mesure

- Journaux sans contenu : `agent.decision.call` (`purpose: run_step`) par pas, `agent.browser.run` par appel (statut, raison, pas, décisions, vetos, durée, tokens, coût).
- Langfuse : sous le span `tool browser_run`, une génération `decision step N` par pas (état envoyé, réponses, porte, action).
- Lecture : tours du modèle principal, tokens et durée par tâche de page, avec et sans connexion, sur un même déploiement. Si le gain est inférieur à 30 % de tours à succès égal, l'outil est retiré.

## Limites connues

- La garde « à effet » du fournisseur est spéculative (elle ne voit pas la cible choisie) ; les mots-clés restent la garde fiable, et un bouton neutre qui engage (« Continuer » en fin de tunnel) peut passer si le fournisseur ne le signale pas.
- Le helper borne le snapshot à 80 éléments dans l'ordre du DOM ; pas de défilement, pas d'iframe.
- Au-delà de 30 options par liste (`optionsTruncated`), les suivantes ne sont pas proposées ; un libellé inconnu est refusé par le helper, qui liste ceux qui existent.
- Jev est annoncé meilleur en anglais ; la justesse sur des pages francophones n'est pas mesurée.
- Seuils (0,80, 0,60 × 2, 0,5) de départ, non calibrés.
