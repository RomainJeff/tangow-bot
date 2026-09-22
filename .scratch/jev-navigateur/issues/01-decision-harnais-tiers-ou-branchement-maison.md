# 01: Décision — harnais navigateur tiers ou branchement de Jev sur `BrowserProvider`

**What to build:** Une décision, pas du code. Question d'origine : pour donner à la partie navigateur du runtime ordinateur un choix de cible et une vérification rapides et bon marché, adopte-t-on `browser-use` ou l'un des harnais Jev publiés par la communauté, ou branche-t-on Jev nous-mêmes sur la pile `browser_*` existante ?

## Ce que le cadrage a établi

**La table de candidats existe déjà.** Tous les harnais étudiés reposent sur la même recette : l'application observe la page, construit une table bornée de candidats exécutables avec un identifiant qu'elle possède, Jev choisit un identifiant, l'application vérifie qu'il est dans la table, exécute, puis vérifie l'issue indépendamment. Chez nous cette table est `BrowserSnapshotResult.elements` (`packages/adapter-kit/src/types.ts`), bornée à 80 éléments par le helper (`infra/sandboxes/computer/rakazo-page-browser:432`) et par la session en process (`packages/adapters/src/page-browser-session.ts:165`), avec un `ref` par élément, un `role`, un `name` (≤200 caractères) et une `value` (mot de passe masqué). Le fail-closed existe aussi : un ref inconnu ou périmé est rejeté avant mutation (`rakazo-page-browser:567`, `page-browser-session.ts:86`) et jamais retargeté. L'observation post-action existe : `act` renvoie `tree` et `elements` d'après. Aucun harnais tiers n'apporte une brique que nous n'avons pas ; ils apportent une boucle que nous avons déjà ailleurs.

**Le SDK officiel est petit et sans surprise.** `@typesafe-ai/sdk` : `new TypeSafeClient({ apiKey, baseURL, defaultModel, timeout, retry, fetch, logger })`, un seul appel `systemOne({ state, questions, model? })` en `POST /v1/systemone`, réponse `{ model, answers, usage }` où chaque réponse `choice` porte `choice`, `confidence` et `probabilities` par option, `noul` porte `noul` (probabilité) et `score` porte `score`, `confidence`, `legend`, `probabilities`. `RequestOptions` accepte `signal` et `timeout` par appel. Erreurs typées : `APIError`, `APITimeoutError`, `APIConnectionError`, `APIUserAbortError`, `TypeSafeError`. Politique de retry avec backoff par défaut, à borner. Pas de batching ni de streaming : une requête HTTP par décision, mais toutes les questions d'un même `state` sont évaluées dans ce seul appel. `baseURL` par défaut `https://api.typesafe.ai`, `defaultModel` par défaut `jev-latest`. La documentation officielle (`docs.typesafe.ai`) n'était pas joignable ; les limites « 255 options pour `choice` » et « 2 à 10 niveaux pour `score` » viennent du brief et ne sont pas vérifiées dans les types, qui n'imposent rien. La taille maximale d'un `state` n'est documentée nulle part de joignable.

## Les options

### A. `browser-use` (l'agent) comme moteur navigateur

Python ≥ 3.11, Playwright, boucle d'agent complète pilotée par un modèle de langage, cloud optionnel. Il n'existe pas d'agent TypeScript officiel ; « Browser Harness JS » donne l'accès navigateur à un agent JS, il ne porte pas la boucle. Chez nous il faudrait soit un sidecar Python côté hôte, soit l'exécuter dans le conteneur ordinateur. Dans les deux cas il veut piloter son propre Chromium ou s'attacher au Chrome du bot par CDP, et il possède la boucle : c'est lui qui déciderait d'enchaîner les pas, alors qu'approbations, baux d'écran, garde d'apprentissage, checkpoint de workspace et prise de contrôle vivent dans `packages/adapters/src/executor.ts` autour de chaque appel d'outil. Ce n'est pas un fournisseur de décision, c'est un second agent. Il n'utilise d'ailleurs pas Jev par défaut.

### B. Un harnais Jev de la communauté comme dépendance

| Dépôt | Langage et pile | Ce qu'il fait | Chiffres publiés | Protocole |
|---|---|---|---|---|
| `trycua/cua` PR #3916 (« jev-use ») | Docs + exemples Python et TypeScript, Cua Driver | La recette de référence : candidats immuables, `reobserve` et `abstain` réservés, ≤32 identifiants par question, réponse hors table refusée, vérification par un endpoint `/state` indépendant, mock déterministe sans credential | 7 cas de fixture vérifiés, 22 tests | Aucune mesure de performance revendiquée ; fusionnée le 2026-09-18, ne touche aucun code runtime |
| `browser-use/jev-ultrafast` | Python 3.12, `browser-harness` 0.1.13 (s'attache au Chrome de l'utilisateur), OpenRouter pour le texte | Espace d'action indexé ; opération et cible en une requête Jev ; texte par petit modèle seulement pour `TYPE_TEXT` ; recheck de fraîcheur et d'occlusion | Google Flights en 7 073 ms ; 6 runs alternés, médiane 9 450 → 7 092 ms | Mesuré et documenté (bornes, hashes de source, `docs/performance.md`), mais **3 paires sur une tâche et un profil**, p = 0,25, les auteurs écrivent eux-mêmes « pas un benchmark de fiabilité » |
| `agent-labs-dev/fastbrowse` | Python 3.13, `uv`, Gemini via OpenRouter, Browser Use Cloud ou Chrome local | Jev choisit parmi les contrôles observés, un LLM planifie et lit, le code gate les actions irréversibles et rédige les secrets ; mots de passe uniquement depuis les secrets stockés | 14 tâches × 3 passes : 41/42 contre 39/42 pour l'agent Browser Use ; coût médian 0,0041 $ contre 0,3668 $ ; temps médian 20,6 s contre 21,6 s | Le mieux documenté (`docs/evals.md`, tâches nommées, critères de réussite par API ou POST enregistré). Mais le modèle de la ligne de base n'est pas précisé, deux tâches held-out ont fuité dans le développement, et le dépôt se déclare « hautement expérimental » |
| `chy4pro/jev-for-chrome` | Extension MV3 dans le Chrome de l'utilisateur, texte par DeepSeek/Gemini/OpenAI-compatible | Deux questions par appel (opération, élément) ; hit-test d'occlusion ; détection de boucle (même contrôle 3× en 6 pas → `BLOCKED`) ; refuse les mots de passe | 13/17 sur une suite headless-Chromium ; 2 à 22 s par tâche ; historique 9, 10, 11, 14, 13, 13, 13 pendant les corrections | Traces JSON publiées et commande de reproduction, mais deux échecs sont des 429 du modèle de texte et un est une erreur de vérification : suite de développement, pas benchmark |
| `jkudish/jev-browser` | **TypeScript**, Node 22, Playwright + Chromium headless, MIT | Un appel Jev par pas avec trois jugements parallèles : action parmi les éléments DOM, but atteint, bloqué ; huit types d'action ; texte par petit modèle ≤256 tokens | Wikipedia Coffee → Espresso en ~4 s pour 0,0016 $ | Exemples, pas de protocole ; pas d'iframe ni de shadow DOM en v0.1 |
| `alexbejan/jevkit` | Python 3.12, Cua Driver ou phone-harness | Trois primitives de jugement : `verify` (`landed / dialog / error / auth / gate`), `pick`, `classify` ; chacune avec un gate `act / caution / stop` sur seuils `JEVKIT_HIGH` / `JEVKIT_LOW` ; `auth` et `error` gatent toujours `stop` ; `JEVKIT_MOCK=1` déterministe, `JEVKIT_DISABLE=1` → `unavailable` | « 37/38 picks » sur Windows, iPhone Réglages en 4 pas | Anecdotique, aucun protocole |
| `fstandhartinger/jevbench` | Harnais MIT, 534 cas figés | Score sur quatre axes : justesse corrigée du hasard, calibration (ECE), latence, coût ; transport natif `/v1/systemone` ou OpenAI-compatible avec schéma | Jev 1.13.0 en tête à 74,4 ; ~950 tokens d'entrée par décision | Rigoureux mais **pas un benchmark navigateur** : maths, code, droit, finance, support, sécurité |

Aucun de ces dépôts n'est utilisable comme dépendance ici : cinq sur six sont en Python, `jev-browser` embarque Playwright et un Chromium headless alors que le nôtre est déjà là, aucun ne s'attache à un Chrome distant par CDP dans un conteneur, tous possèdent leur boucle. Deux d'entre eux ont en revanche une conception à porter : `jevkit` pour les primitives et le gate à trois niveaux, `jev-use` pour la forme exacte de la requête (`fixtures/jev-choice-request-v1.json`), le refus de tout ce qui n'est pas dans la table et le mock derrière la même frontière que l'adaptateur réel.

### C. Brancher Jev nous-mêmes sur `BrowserProvider`

Une interface `DecisionProvider` dans `packages/adapter-kit`, un adaptateur TypeSafe dans `packages/adapters` derrière une connexion partagée, un fake en process, une conformité offline — le patron exact de `browser-provider-factory.ts` / `fake-browser.ts` / `browser-conformance.test.ts` et de `memory-provider-factory.ts` pour la connexion. Deux points d'accroche seulement : la résolution d'une cible décrite en `ref` dans `browser-tools.ts`, et l'annotation du snapshot d'après dans `BrowserActResult`. Zéro dépendance nouvelle hors le SDK, lui-même optionnel et chargé seulement quand une connexion existe.

## Critères de décision

Écrits avant la comparaison.

- **Aucun vendeur hébergé requis** pour faire tourner le cœur : élimine tout ce qui impose Python, Playwright, un cloud ou une clé.
- **Le backend possède la boucle** : approbation, baux, garde d'apprentissage, checkpoint, prise de contrôle restent où ils sont ; élimine toute solution qui enchaîne les pas elle-même.
- **Chrome reste dans le sandbox** avec ses profils persistants par bot et son CDP sur la boucle locale ; élimine extension MV3 et Chromium tiers.
- **Fail-closed** : Jev ne peut produire qu'un identifiant de la table courante ; toute autre réponse est rendue au modèle.
- **Coût de possession** : lignes à écrire chez nous contre surface de dépendance à suivre ; un harnais expérimental à une release par jour est une charge, pas une économie.

## Recommandation

**Option C, tranchée.** Ni `browser-use` ni aucun harnais Jev de la communauté n'entre dans le dépôt. On branche Jev sur `BrowserProvider` derrière `DecisionProvider`, en portant en TypeScript la conception de `jevkit` (verify / pick, gate `act / caution / stop`, mode désactivé qui répond `unavailable`) et la discipline de `jev-use` (table immuable possédée par l'app, `none` réservé, réponse hors table refusée, mock derrière la même frontière). Les harnais restent des lectures citées dans les tickets 04 et 05.

Deux réserves honnêtes, à ne pas perdre :

1. **Le gain de justesse n'est pas démontré.** Le seul face-à-face public à protocole écrit (fastbrowse) gagne sur le coût et le temps, pas sur la réussite. Le gain attendu chez nous est mécanique — le modèle principal ne lit plus 12 000 caractères de page pour cliquer un bouton — et c'est le ticket 08 qui le mesure. Si 08 ne montre ni baisse de tokens ni baisse de tours, le lot s'arrête à 02–05 et le fake reste le seul provider.
2. **Le français.** Jev est annoncé « meilleur en anglais ». Les libellés de nos pages sont souvent en français. Aucun dépôt étudié n'a mesuré cela. Le ticket 06 doit inclure des pages francophones dans son corpus avant de figer un seuil.

Hors périmètre de cette décision : la boucle autonome `browser_run`, le bureau en pixels, le gate d'approbation par Jev — voir `NON-GOALS.md`.

## Décision — 2026-09-22

**Option C confirmée par le mainteneur.** Aucune dépendance tierce. On branche Jev nous-mêmes sur `BrowserProvider` derrière `DecisionProvider`. Raison consignée : les harnais étudiés n'apportent aucune brique qui nous manque — la table de candidats bornée, le fail-closed sur ref périmé et l'observation post-action existent déjà dans le dépôt — ils n'apportent qu'une boucle d'agent que `executor.ts` possède déjà, dans un langage qui n'est pas le nôtre. `NON-GOALS.md` reste tel quel.

Quatre décisions de cadrage prises en même temps, qui contraignent les tickets suivants :

**1. `target` est réservé aux actions réversibles en v1.** Le choix de cible par le fournisseur ne s'applique pas à une action à effet (paiement, suppression, soumission irréversible) : pour celles-là, le modèle fournit un `ref` explicite comme aujourd'hui. Motif : `planActionGate` juge *l'action*, pas *la cible* — il ne peut pas dire « ce bouton n'est pas celui que tu crois », et le contrat interdit déjà le rejeu. La restriction se lève quand 06 aura des chiffres. Porté au ticket 04.

**2. Le premier lot livré s'arrête au choix de cible.** Ordre : 02, 03, 04, 08. Le ticket 05 (vérification post-action) est différé : il n'économise aucun token, il ajoute une latence, et livré en même temps que 04 il rendrait la mesure du 08 inattribuable. Il devient plus simple après 04, qui lui fournit le `before` complet sans faire retenir un snapshot à l'exécuteur.

**3. Pas de mode observation préalable.** On expédie 04 avec le seuil `high` à 0,80 écrit en dur, on mesure avec 08, on ajuste avec 06. Un étage d'observation « Jev choisit mais n'exécute pas » a été proposé et écarté : sur-ingénierie avant le premier chiffre.

**4. Le français n'est pas un gate.** La doc officielle confirme que l'anglais est la langue d'entraînement principale et ne publie aucun chiffre par langue (« test on your own content »). Le mainteneur a tranché : on ne construit pas de corpus francophone avant de livrer. La réserve reste écrite ci-dessus ; 06 la reprendra s'il y a lieu.

## Faits résolus dans la documentation officielle

`docs.typesafe.ai` était joignable ; l'échec noté plus haut était local à l'autre poste. Les trois inconnues du cadrage sont closes :

- **255 options par `choice`**, documenté deux fois (`api.md`, `primitives/choice.md`). Le SDK n'impose rien côté client : le dépassement est un `422` serveur. Nos 80 refs passent sans troncature — le ≤32 de `jev-use` était auto-imposé et sans base. `score` est borné séparément à 10 niveaux.
- **Taille de `state` : aucune limite en caractères ou en octets.** Le seul plafond documenté est le contexte : 32k tokens pour le `state` plus la question la plus longue, 64k pour l'ensemble (`models.md`). Nos états bornés sont très en dessous. À retenir tout de même : « accuracy falls as the state grows with content unrelated to the decision » — ce qui confirme le choix du ticket 04 de ne pas envoyer le texte de page.
- **Pas de transport OpenAI-compatible.** `typesafe/jev-1.13` est absent du catalogue chat-completions d'OpenRouter ; il n'est servi que par une « Decisions API » hors du préfixe `/api/v1`, dont les SDK chat ne savent pas parler. La case est close dans sa forme initiale, mais avec une conclusion utile pour 02 : cette Decisions API est un quasi-clone du contrat TypeSafe (même corps, probabilités par option exposées), donc un second adaptateur reste possible à peu de frais si les quotas TypeSafe se resserrent. Noté, pas écrit.
- **Prix et quotas** : 0,042 $/Mtok en entrée, sortie gratuite ; ~100 ms annoncés, 0,22 s P50 mesurés par OpenRouter ; 1 200 requêtes/min et 250k tokens/s, « adjusting dynamically, can change without notice ».
- **Version du modèle épinglée** : `jev-latest` et `jev-preview` résolvent aujourd'hui vers `jev-1.13.0` mais bougent, et la doc conseille d'épingler dès qu'on règle des seuils de confiance. 04 en câble un. L'adaptateur épingle donc `jev-1.13.0` au lieu de `jev-latest` ; la réponse porte toujours la version qui a répondu, que 08 logue. Porté au ticket 03.

**Blocked by:** Rien.

**Status:** decided — 02 ouvert

- [x] Recommandation C confirmée par le mainteneur, raison consignée ci-dessus
- [x] `NON-GOALS.md` reste tel quel
- [x] Limite d'options (255) et budget de `state` (32k tokens) lus dans la documentation officielle et reportés au ticket 04
- [x] Transport OpenAI-compatible examiné : inexistant pour ce modèle ; la Decisions API d'OpenRouter reste un second adaptateur possible, noté sans être écrit
