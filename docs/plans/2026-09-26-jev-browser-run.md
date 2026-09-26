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
3. Une requête par pas (`decideWithin`, `purpose: "run_step"`, 1,5 s) : `operation` (click, fill, select, wait, done, blocked, restreint aux opérations qui ont des candidats), et par opération une question spéculative de cible : élément cliquable pour `click`, paire (champ, clé de `values`) ou (champ, « aucune valeur fournie ») pour `fill` et `select`  ; plus `goal_done` (oui/non). Seule `operation` est obligatoire : `DecideOptions.optional` écarte une réponse spéculative mal formée sans invalider le pas.
4. Portes : cible choisie ≥ 0,80, ou ≥ 0,60 et au moins le double du meilleur autre élément (hors « aucun »), sinon `blocked` avec trois candidats ; la marge vient de la production, où deux boutons d'avancement équivalents (« CONTINUER » 0,65, « Suivant » 0,30) bloquaient une étape sans ambiguïté ; paire « aucune valeur » → `needs_input` `value` ; `done` contredit par `goal_done` < 0,5 refusé une fois ; `blocked` du fournisseur → `blocked`.
5. Agir : une étape `act`, décision consommée avant (jamais rejouée). Un `select` natif passe par `fill` avec le libellé. `wait` = 500 ms puis snapshot, au plus deux de suite. Après un `fill` dans une combobox, 250 ms puis snapshot.
6. Arrêts : trois pas sans changement de page, même contrôle une troisième fois en six pas, action incertaine ou deux échecs de suite, `maxSteps` (25 par défaut, 40 au plus), 120 s, 2 × `maxSteps` décisions, annulation du run (relancée, jamais convertie).

Pas de second LLM pour le texte : les valeurs viennent de `values`, une valeur absente rend `needs_input`.

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
- Les options d'un `select` ne sont pas listées ; le fournisseur apparie la valeur fournie au champ, et le helper refuse un libellé inconnu en listant ceux qui existent.
- Jev est annoncé meilleur en anglais ; la justesse sur des pages francophones n'est pas mesurée.
- Seuils (0,80, 0,60 × 2, 0,5) de départ, non calibrés.
