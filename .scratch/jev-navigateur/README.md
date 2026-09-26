# Jev pour la partie navigateur du runtime ordinateur

> **Remplacé** par [`docs/plans/2026-09-26-jev-browser-run.md`](../../docs/plans/2026-09-26-jev-browser-run.md) : ces tickets restent pour l'historique.

Cadrage de l'usage d'un modèle de décision typée (Jev, « System One » de TypeSafe AI, septembre 2026) dans la boucle `browser_navigate` / `browser_snapshot` / `browser_act` des bots. Chaque ticket est ancré sur le contrat navigateur réellement livré dans le dépôt, pas sur la recette d'un harnais tiers — voir `NON-GOALS.md` pour ce qui a été écarté et pourquoi.

## Le problème

Aujourd'hui la boucle navigateur coûte un tour de modèle par pas. Le modèle principal appelle `browser_snapshot`, reçoit jusqu'à 12 000 caractères de texte de page plus 80 éléments interactifs (`infra/sandboxes/computer/rakazo-page-browser:432-438`), lit tout, puis appelle `browser_act` avec un `ref`. Trois appels d'outil et deux lectures complètes de page pour un clic. Le texte de page entre dans le contexte du modèle à chaque pas, et c'est ce texte qui coûte, pas l'action.

Ce que Jev change : il prend un `state` texte et une map de questions typées, et renvoie en un passage une réponse par question avec une distribution de probabilités et une confiance. Trois primitives : `noul` (oui/non → probabilité), `choice` (une option parmi une liste close), `score` (échelle bornée). Entrée texte uniquement, ~0,042 $ par million de tokens d'entrée, sortie gratuite, latence annoncée entre 70 et 500 ms selon les sources. Il ne génère pas de texte et ne peut donc ni inventer un `ref`, ni écrire une valeur de champ, ni planifier.

**L'observation clé, vérifiée dans le code :** `browser_snapshot` produit déjà exactement la « table de candidats bornée » que tous les harnais Jev de la communauté reconstruisent à la main — au plus 80 éléments avec un `ref` stable (borne posée par le helper `rakazo-page-browser:432` ; le fake jsdom n'en a pas), rendus en `- role "name" [ref]` (`packages/adapters/src/computer-browser.ts:209`, `packages/adapters/src/page-browser-session.ts:184`). Le préflight du helper rejette les refs périmés avant toute mutation (`rakazo-page-browser:568`), et `browser_act` renvoie déjà le snapshot d'après (`BrowserActResult.tree/elements`, `packages/adapter-kit/src/types.ts`). La table, le fail-closed et l'observation post-action existent. Ce qui manque, c'est un fournisseur de décision optionnel branché dessus.

## Ce que le lot propose

Deux usages, dans cet ordre, tous deux derrière une interface neutre `DecisionProvider` avec fake en process et conformité offline :

1. **Choix de cible** — `browser_act` accepte une description de cible (`target`) en plus du `ref`. Le backend prend un snapshot, pose un `choice` sur les refs courants plus une option `none`, exécute si la confiance passe le seuil, sinon rend les candidats au modèle qui choisit lui-même comme aujourd'hui. Le modèle principal n'a plus à lire la page pour cliquer dessus.
2. **Vérification post-action** — sur le snapshot d'après que `act` renvoie déjà, un `choice` classe l'issue en `landed | dialog | error | auth | unchanged`, annoté dans le résultat avec sa confiance. Consultatif : jamais de rejeu automatique, le contrat `docs/computer-runtime.md` reste intact.

Ce que Jev ne fait jamais dans ce lot : écrire une valeur de champ (le modèle garde `text`), choisir une URL, décider seul d'enchaîner des pas, produire un `ref` absent de la table, bloquer la boucle. Pas de provider configuré, timeout, erreur, consentement absent ⇒ le tour actuel, inchangé.

## Ordre

| # | Titre | Bloqué par | Statut |
|---|---|---|---|
| 01 | Décision — harnais navigateur tiers ou branchement de Jev sur `BrowserProvider` | — | decided (2026-09-22), option C |
| 02 | Interface `DecisionProvider`, fake en process et conformité offline | 01 | ready-for-agent |
| 03 | Adaptateur TypeSafe derrière une connexion partagée | 02 | ready-for-agent |
| 04 | Choix de cible pour `browser_act` par `choice` sur les refs du snapshot | 02 | ready-for-agent |
| 05 | Vérification post-action `landed / dialog / error / auth / unchanged` | 02 | différé après la mesure de 04 |
| 06 | Calibrer les seuils hors ligne sur un corpus étiqueté | 03, 04, 05 | needs-decision |
| 07 | Déclarer le fournisseur de décision comme destinataire de données | 02 | ready-for-agent |
| 08 | Mesurer ce que le fournisseur de décision rapporte réellement | 04, 05 | ready-for-agent |

**Décision du 2026-09-22 :** option C retenue. Premier lot livré : 02, 03, 04, 08. `target` réservé aux actions réversibles ; 05 différé pour que 08 mesure un seul changement. Détail et faits de documentation dans le ticket 01.

01 est la seule vraie décision et elle est tranchée dans le ticket : aucune dépendance tierce, branchement maison sur le `BrowserProvider` existant, les harnais de la communauté servent de références de conception. 02 est le socle et se livre avec le fake seul, sans clé ni réseau. 03 est le seul ticket qui touche un SDK vendeur. 04 et 05 sont indépendants l'un de l'autre et testables sur le fake. 06 est le ticket qui dit si les seuils tiennent — et il commence par constater que les fixtures de replay actuelles sont trop maigres pour calibrer quoi que ce soit. 07 est une conséquence mécanique de `docs/ai-data-sharing-review.md` : du texte de page part vers un nouveau destinataire. 08 est l'équivalent du ticket 17 du lot `harness-context-quality` : sans lui personne ne saura si l'ensemble vaut son coût.

## Ce qui reste non mesurable avant 06 et 08

Si Jev choisit mieux qu'un modèle de langage la bonne cible parmi 80 : aucun des dépôts étudiés ne publie cette comparaison à protocole égal. Le seul face-à-face public (fastbrowse, 14 tâches × 3 passes) montre un gain de coût et de temps, pas de justesse (41/42 contre 39/42). Le gain attendu ici est donc d'abord un gain de tours et de tokens du modèle principal, et c'est cela que 08 mesure. La justesse sur des pages en français est également inconnue : Jev est annoncé « meilleur en anglais », et nos bots naviguent sur des sites francophones.
