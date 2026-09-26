# Jev pour la partie navigateur du runtime ordinateur

Cadrage de l'usage d'un modèle de décision typée (Jev, « System One » de TypeSafe AI, septembre 2026) dans la boucle `browser_navigate` / `browser_snapshot` / `browser_act` des bots. Chaque ticket est ancré sur le contrat navigateur réellement livré dans le dépôt, pas sur la recette d'un harnais tiers — voir `NON-GOALS.md` pour ce qui a été écarté et pourquoi.

## Le problème

Aujourd'hui la boucle navigateur coûte un tour de modèle par pas. Le modèle principal appelle `browser_snapshot`, reçoit jusqu'à 12 000 caractères de texte de page plus 80 éléments interactifs (`infra/sandboxes/computer/rakazo-page-browser:432-438`), lit tout, puis appelle `browser_act` avec un `ref`. Trois appels d'outil et deux lectures complètes de page pour un clic. Le texte de page entre dans le contexte du modèle à chaque pas, et c'est ce texte qui coûte, pas l'action.

Ce que Jev change : il prend un `state` texte et une map de questions typées, et renvoie en un passage une réponse par question avec une distribution de probabilités et une confiance. Trois primitives : `noul` (oui/non → probabilité), `choice` (une option parmi une liste close), `score` (échelle bornée). Entrée texte uniquement, ~0,042 $ par million de tokens d'entrée (chiffre TypeSafe ; via OpenRouter, le coût réel de chaque appel est journalisé depuis `usage.cost`), sortie gratuite, latence annoncée entre 70 et 500 ms selon les sources. Il ne génère pas de texte et ne peut donc ni inventer un `ref`, ni écrire une valeur de champ, ni planifier.

**L'observation clé, vérifiée dans le code :** `browser_snapshot` produit déjà exactement la « table de candidats bornée » que tous les harnais Jev de la communauté reconstruisent à la main — au plus 80 éléments avec un `ref` stable (borne posée par le helper `rakazo-page-browser:432` ; le fake jsdom n'en a pas), rendus en `- role "name" [ref]` (`packages/adapters/src/computer-browser.ts:209`, `packages/adapters/src/page-browser-session.ts:184`). Le préflight du helper rejette les refs périmés avant toute mutation (`rakazo-page-browser:568`), et `browser_act` renvoie déjà le snapshot d'après (`BrowserActResult.tree/elements`, `packages/adapter-kit/src/types.ts`). La table, le fail-closed et l'observation post-action existent. Ce qui manque, c'est un fournisseur de décision optionnel branché dessus.

## Ce que le lot propose

Deux usages, dans cet ordre, tous deux derrière une interface neutre `DecisionProvider` avec fake en process et conformité offline :

1. **Choix de cible** (livré) — `browser_act` accepte une description de cible (`target`) en plus du `ref`. Le backend prend un snapshot, pose un `choice` sur les liens, onglets ou champs texte courants plus une option `none`, exécute si la probabilité de l'option choisie atteint 0,80, sinon rend les candidats au modèle qui choisit lui-même comme aujourd'hui. Le modèle principal n'a plus à lire la page pour cliquer dessus.
2. **Vérification post-action** (livré, lot 2) — sur le snapshot d'après que `act` renvoie déjà, un `choice` classe l'issue en `landed | dialog | error | auth | unchanged`, annoté dans le résultat avec sa confiance. Consultatif : jamais de rejeu automatique, le contrat `docs/computer-runtime.md` reste intact.

Ce que Jev ne fait jamais dans ce lot : écrire une valeur de champ (le modèle garde `text`), choisir une URL, décider seul d'enchaîner des pas, produire un `ref` absent de la table, bloquer la boucle. Pas de provider configuré, timeout, erreur, réponse invalide ⇒ le tour actuel, inchangé.

## Ordre

| # | Titre | Bloqué par | Statut |
|---|---|---|---|
| 01 | Décision — harnais navigateur tiers ou branchement de Jev sur `BrowserProvider` | — | decided (2026-09-22), option C |
| 02 | Interface `DecisionProvider`, fake en process et conformité offline | 01 | done (lot 1, 2026-09-26) |
| 03 | Adaptateur ~~TypeSafe~~ OpenRouter derrière une connexion par espace | 02 | done (lot 1, 2026-09-26) |
| 04 | Choix de cible pour `browser_act` par `choice` sur les refs du snapshot | 02 | done (lot 1, 2026-09-26) |
| 05 | Vérification post-action `landed / dialog / error / auth / unchanged` | 02, 04 | done (lot 2, 2026-09-26) |
| 06 | Calibrer les seuils hors ligne sur un corpus étiqueté | 04, 05 (famille issues) | outillage livré (2026-09-26) ; en attente d'enregistrements réels et de relecture du corpus |
| 07 | Déclarer le fournisseur de décision comme destinataire de données | 02 | retiré (2026-09-26, décision du mainteneur) |
| 08 | Mesurer ce que le fournisseur de décision rapporte réellement | 04 | done (lot 1, 2026-09-26, logs seulement) ; lecture en attente |
| 09 | `browser_run` : sous-tâche de page pilotée par Jev (rouvre un non-objectif) | 02, 03 | needs-review |

**Décision du 2026-09-22 :** option C retenue (détail dans le ticket 01). 05 avait été différé pour que 08 mesure 04 seul ; le mainteneur a levé ce report le 2026-09-26.

## Lot 1 livré (2026-09-26)

Branche `feat/jev-browser-target`. Ces choix l'emportent sur le texte d'origine des tickets 02, 03, 04, 07 et 08, qui gardent chacun une section « Livré » avec leurs écarts.

- **Contrat** neutre `DecisionProvider` (`packages/adapter-kit`), `decideWithin` qui ne lève jamais (raisons `no_provider | timeout | aborted | error | invalid_answer`, pas de `not_consented`) ; une option choisie sans probabilité est `invalid_answer`. Fake **scripté seulement** ; conformité contre l'adaptateur OpenRouter sur l'exemple documenté.
- **Transport** : API Decisions d'OpenRouter (`POST /api/alpha/decisions`, alpha, gardée volontairement), `fetch` simple, une tentative, aucun SDK TypeSafe ; modèle par défaut `typesafe/jev-1.13` (pas l'alias `~typesafe/jev-latest`), `maxOptions` 255.
- **Connexion par espace** : table `SpaceDecisionConfig`, fournisseur `openrouter`, clé propre à l'espace (ni `OPENROUTER_API_KEY` ni connexions de modèle), `baseUrl` et `modelId` optionnels ; endpoint privé réservé au propriétaire du déploiement. Réglages → Navigateur sur web et desktop, **pas d'écran mobile**. Aucune variable d'environnement.
- **`target`** : restreint par rôle de candidat (`click` → `link`, `tab`, `button` depuis `9f36c00c` ; `fill`/`type` → `textbox`, `searchbox`, `combobox`) ; refs avant targets ; ≤ 6 targets par appel ; options `role "name"` (nom ≤ 120), ni valeurs ni texte de page ; secrets redigés ; délai 1 000 ms.
- **Gate** : exécuter si la probabilité de l'option choisie ≥ 0,80 ; `confidence` (concentration de la distribution, exemple documenté 0,75 pour un choix à 0,84) seulement journalisée. Sinon `needsRef` avec le snapshot et jusqu'à trois `candidates`.
- **Données** : usage `decision` et destinataire dérivé de la connexion ; porte mobile existante ; **pas** de porte serveur ; `AI_DISCLOSURE_VERSION` **inchangée** (décision du mainteneur).
- **Mesure** : logs `agent.decision.call` (dont tokens d'entrée et `usage.cost`), `agent.browser.target`, `agent.run.decision` ; ni `UsageRecord` ni colonnes `ExternalEffect`.
- Hors périmètre : le doublon amont `jev-auto-review.ts`.

## Prochaines étapes

1. ~~**05**~~ livré (lot 2, branche `feat/jev-browser-verify`) : `outcome` consultatif après la dernière action à `target`, `purpose` dans `agent.decision.call`, `agent.browser.outcome`, compteurs `verify*`.
2. ~~**06** outillage~~ livré (branche `feat/jev-browser-calibration`) : corpus de 110 cas fr/en, constructeur par `browserActFromTool`, `pnpm test:decision-calibration`. Reste : relecture humaine du corpus, puis un enregistrement réel (clé sur stdin, voir le ticket). Les seuils 0,80 et 0,5 restent des valeurs de départ jusque-là.
3. Lecture de 08 sur un espace connecté, de préférence sur des jours d'avant 05 pour le gain de 04.

## Ce qui reste non mesurable avant 06 et 08

Si Jev choisit mieux qu'un modèle de langage la bonne cible parmi 80 : aucun des dépôts étudiés ne publie cette comparaison à protocole égal. Le seul face-à-face public (fastbrowse, 14 tâches × 3 passes) montre un gain de coût et de temps, pas de justesse (41/42 contre 39/42). Le gain attendu ici est donc d'abord un gain de tours et de tokens du modèle principal, et c'est cela que 08 mesure. Aucune de ces questions n'a encore de réponse : il n'existe ni enregistrement réel ni lecture de logs. La justesse sur des pages en français est également inconnue : Jev est annoncé « meilleur en anglais », et nos bots naviguent sur des sites francophones.
