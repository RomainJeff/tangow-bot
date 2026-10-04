# `delegate-to-opencode` v2 — Plan
> **Statut :** implémenté (skill `delegate-to-opencode` v2, skill computer `own-the-task`).

**Goal :** le bot (pas un dev, parle à des non-devs) confie du travail de code à OpenCode sur le computer, en lance plusieurs en parallèle, **rend la main à l'utilisateur tout de suite**, revient de lui-même quand c'est fini, fait vérifier le résultat, et l'explique en langage simple. OpenCode possède la boucle complète (onboard → code → tests → preview → PR). L'utilisateur ne touche jamais au computer, sauf en dernier recours.

* * *
## 1. Ce que l'exploration a établi
**Rakazo (main** `9d80c235`**)**

- `shell` : 5 min de timeout, non réglable par le modèle. Le guard refuse `$VAR` (hors liste blanche), `$(…)`, backticks, `kill`, `eval`, `source`. **Mais** `bash /chemin/script.sh args` **passe** : le corps du script n'est pas inspecté.
  
- **Les process** `nohup … &` **survivent** à la fin de la commande et du run, et **empêchent l'idle shutdown** (marqueur fd 9, `computer-idle.ts`). Pas de durée max. Ils meurent seulement si l'utilisateur fait Stop sur le run, ou si le computer est suspendu.
  
- **Reprise autonome :** `schedule_create` one-shot (`delayMinutes` / `delaySeconds`) crée un run `routine` dans le même thread. C'est la seule primitive dispo aujourd'hui pour « revenir plus tard » sans bloquer le thread. Rien ne surveille le filesystem du computer.
  
- **Polling dans le même tour = mauvaise idée :** le run reste actif, les messages de l'utilisateur deviennent du steering dans ce run, et le bot est occupé pendant 20 min.
  
- **Progressive disclosure OK :** `skill_read` renvoie `dir` (`/managed-skills/agent/delegate-to-opencode`), Pi lit `references/*.md` avec `cat`, lance `scripts/*` avec `bash`. Docker uniquement (pas de montage sur E2B / Daytona / Box).
  
- **OpenCode 1.18.34** installé, `OPENCODE_DISABLE_AUTOUPDATE=1`, skills `computer` liés dans `~/.config/opencode/skills`. **Aucun** `opencode.json` : permissions par défaut (`external_directory` et `doom_loop` en `ask`).
  
- **Credentials :** aujourd'hui seulement `opencode auth login` dans le terminal du computer (takeover). Les agent secrets passent en env (donc `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` marcheraient) mais **pas d'UI** (API only) et visibles par tous les bots du Team computer.
  

**OpenCode**

- `opencode run --format json --auto --dir <path> --title <t> -m <model> -f <brief>` : bloque jusqu'à la fin, NDJSON sur stdout (`sessionID` sur chaque ligne), exit 0/1. Sans `--auto`, un `ask` est **rejeté silencieusement** (pas de blocage, mais tool call en échec).
  
- `opencode run -s <sessionID> --dir <path> "<correction>"` : relance la **même session** avec son contexte → follow-up.
  
- `opencode serve` + `POST /session/:id/prompt_async` + `GET /session/status` : la version « serveur » de la même chose. Plus propre, mais 4 inconnues (`?directory=`, comportement d'un `ask` sur serve, mot de passe, serveur qui garde le computer éveillé en permanence).
  
- Deux sessions dans le même checkout s'écrasent → **un git worktree par job**. Le support worktree natif est expérimental (et a eu une faille) : on le fait nous-mêmes.
  
- Config headless : `permission` sans aucun `ask`, `question: deny`, `doom_loop: deny`, `share: disabled`, `autoupdate: false`.
  

* * *
## 2. Décisions
1. **La primitive est un script, pas un nouveau tool.** `scripts/oc` dans le skill. Il a le droit d'utiliser `$`, `kill`, `jq`, `git worktree` ; le modèle l'appelle avec des arguments littéraux. Zéro changement de code Rakazo pour la v1. Les tools `code_agent_*` restent la suite si le pattern montre ses limites.
  
2. **Un process** `opencode run` **par job, pas** `opencode serve`**.** Chaque job tient son propre marqueur (le computer reste éveillé tant qu'un job tourne, puis peut dormir), le statut = fichier de sortie + NDJSON, le stop = `kill` dans le script. Moins d'inconnues. `serve` seulement si on a besoin du streaming ou d'un vrai abort propre.
  
3. **Un worktree par job**, sous `~/oc-jobs/<id>/`, branche `oc/<id>`. Parallélisme sans collision.
  
4. **Non bloquant via** `schedule_create`**.** Après `oc start`, le bot pose un rappel one-shot dans le thread (« vérifie le job `<id>` ») et rend la main. Au réveil : fini → review + rapport (avec `notify`) ; pas fini → nouveau rappel, silencieux. Le bot ne poll **jamais** dans le tour.
  
5. **OpenCode possède la boucle, Pi juge l'intention.** Pi n'est pas dev : il ne relit pas le diff ligne à ligne. OpenCode termine chaque job par un `REPORT.md` structuré ; la vérification technique est faite par **une seconde session OpenCode en relecture** (agent `plan`, read-only, skill `interrogate`-like côté computer). Pi compare le rapport à la demande de l'utilisateur et traduit.
  
6. **Config headless livrée avec le skill.** `opencode.json` dans le dossier du skill, passé par `OPENCODE_CONFIG` par le script. Aucun `ask` possible. `git push` autorisé seulement si le brief le dit (deux configs : `opencode.json` / `opencode-push.json`).
  
7. **Setup et pannes = parcours guidé pour non-dev.** `oc doctor` renvoie un état machine (`ready` / `no_opencode` / `no_credentials` / `no_repo_access` / `unsupported_computer`) ; `references/setup.md` donne pour chaque état le message à l'utilisateur, en langage simple, et l'action la moins chère pour lui. Le bot ne demande jamais de clé dans le chat.
  

* * *
## 3. Contenu du skill
```
skills/agent/delegate-to-opencode/
  SKILL.md                 ~40 lignes, toujours chargé
  scripts/oc               la primitive (bash)
  opencode.json            config headless (pas de push)
  opencode-push.json       idem + git push / gh pr create
  references/
    setup.md               premier lancement, credentials, pannes de setup
    brief.md               gabarit de brief + exemples
    review.md              lire un rapport, lancer la relecture, follow-up
    talking-to-user.md     comment annoncer, faire patienter, expliquer
    troubleshooting.md     job bloqué, échoué, tests rouges, conflit
```

Plus **une nouvelle skill** `computer` : `skills/computer/own-the-task/` — ce qu'OpenCode doit faire quand il reçoit un brief de Rakazo : lire `repo-onboard`, travailler sur sa branche, définir « fini » à partir des critères du brief, vérifier (tests, `run-and-preview`), puis écrire `REPORT.md` au format imposé (statut, ce qui a changé en une phrase non technique, comment c'est vérifié, ce qui reste ouvert, lien de preview / PR). C'est elle qui rend OpenCode autonome ; le brief de Pi reste court.
### `SKILL.md` (niveau 1)
- Quand l'utiliser / ne pas l'utiliser (une ligne chacun).
  
- La boucle en 5 étapes, une ligne chacune :
  
  1. `bash <dir>/scripts/oc doctor` → si pas `ready`, lire `references/setup.md`.
    
  2. Écrire le brief selon `references/brief.md` (toujours le relire : c'est là que se joue la qualité du résultat).
    
  3. `bash <dir>/scripts/oc start --repo <path> --brief <file> [--push]` → renvoie `<id>`.
    
  4. Dire à l'utilisateur ce qui part et quand il aura des nouvelles ; `schedule_create` one-shot avec le prompt de vérification ; rendre la main.
    
  5. Au réveil : `oc status <id>` → fini : `references/review.md` ; en cours : re-planifier ; bloqué/échec : `references/troubleshooting.md`.
    
- Les commandes de `oc` en une ligne chacune.
  
- 3 règles : jamais de clé dans le chat ; jamais de polling dans le tour ; jamais de jargon sans traduction.
  
### `scripts/oc` (la primitive)
| Commande | Effet | Sortie |
|---|---|---|
| `doctor` | opencode présent ? credentials (`opencode auth list` + env) ? `gh auth status` ? computer Docker ? | `state=<…>` + une ligne d'aide |
| `start --repo P --brief F [--push] [--model M] [--agent plan] [--effort high]` | worktree `oc/<id>`, copie du brief, `nohup opencode run --format json --auto --dir … -f brief` ; écrit `job.json` (id, repo, branche, pid, sessionID, début) | `id=<id>` |
| `status [<id>]` | `running` / `done` / `failed` / `stalled` (log figé > 10 min) + durée + dernière action lisible | une ligne par job |
| `result <id>` | `REPORT.md` + `git diff --stat` + exit code | texte |
| `send <id> F` | follow-up dans la **même session** (`run -s`), en background | `ok` |
| `review <id>` | lance la session de relecture read-only sur le worktree | `id=<id>-review` |
| `stop <id>` | `kill` du process | `stopped` |
| `clean <id>` | supprime le worktree (garde la branche si poussée) | `ok` |

Sortie toujours courte et stable : c'est Pi qui la lit, à chaque réveil.
### Ce que dit `references/brief.md` (prompter OpenCode à l'état de l'art)
Sources : Anthropic, _Claude Code best practices_ et _Prompting best practices_ (Claude 4+) ; OpenAI, _Codex prompting guide_ et _GPT-5 prompting guide_ ; docs OpenCode (agents, skills). Le principe commun en 2026 : **on donne au coding agent un objectif vérifiable et le contexte, pas une liste d'étapes** ; c'est lui qui explore, planifie et vérifie.

**Gabarit imposé** (sections fixes, Markdown, le brief tient sur un écran) :

1. **Objectif** — le résultat attendu, du point de vue de l'utilisateur, en une ou deux phrases. Puis **pourquoi** : à quoi ça sert. Le « pourquoi » permet à l'agent de trancher seul les cas non prévus.
  
2. **Demande d'origine** — les mots de l'utilisateur **verbatim**, entre guillemets. Pi ne paraphrase pas en jargon qu'il ne maîtrise pas.
  
3. **Contexte** — repo, branche de base, fichiers / pages / écrans concernés si connus, exemple existant à imiter (« comme la page Contact »), captures ou URL, données de test. Pointer, pas copier : l'agent lit lui-même.
  
4. **Critères de fin vérifiables** — ce qui doit être vrai pour que ce soit fini, formulé de façon testable : commande qui passe, comportement observable dans le navigateur, test à ajouter. **C'est la section la plus importante** : un agent qui peut vérifier son travail itère jusqu'à y arriver.
  
5. **Contraintes et hors périmètre** — ce qu'il ne faut pas toucher, dépendances interdites, style à respecter. Formulé en positif quand possible (« garde l'API publique inchangée » plutôt que « ne casse pas »).
  
6. **Livraison** — renvoyer à la skill `own-the-task` (format `REPORT.md`, preview, pas de push sauf `--push`).
  

**Règles d'écriture :**

- **Une tâche = un brief = une session.** Deux sujets indépendants → deux jobs en parallèle, pas un brief fourre-tout.
  
- **Pas d'étapes d'implémentation** sauf contrainte réelle : Pi n'est pas dev, ses étapes seraient fausses et brideraient l'agent.
  
- **Ton calme, pas de MAJUSCULES ni de « CRITICAL »** : les modèles récents sur-réagissent aux injonctions criées.
  
- **Exemples concrets > adjectifs** : « le bouton doit ressembler à celui de `/pricing` » plutôt que « un joli bouton ».
  
- **Lever l'ambiguïté avant de lancer, pas pendant** : OpenCode ne peut pas poser de question (`question: deny`). Si un critère de fin manque, Pi pose **une** question simple à l'utilisateur, ou choisit un défaut raisonnable et l'écrit dans le brief (« si X n'est pas précisé, fais Y »).
  
- **Tâche floue ou grosse → deux temps** : d'abord un job `--agent plan` (lecture seule) qui produit un plan court ; Pi le résume à l'utilisateur en langage simple, obtient son accord, puis lance le job de build avec le plan en pièce jointe. Coût : un aller-retour ; gain : pas 40 min de travail dans la mauvaise direction.
  
- **Bug → reproduction d'abord** : le brief décrit le symptôme exact (ce que l'utilisateur fait, ce qu'il voit, ce qu'il attendait) et exige un test qui reproduit le bug avant le correctif.
  
- **Effort du modèle** : `--variant high` pour les tâches difficiles (bug intermittent, refactor transverse), défaut sinon. `oc start --effort high` le passe.
  
- **Follow-up (**`oc send`**)** : ne réexpliquer que l'écart. « Le critère 2 n'est pas rempli : sur mobile le bouton est caché. Le reste est bon, n'y touche pas. »
  

**Exemples dans le fichier** : 3 briefs complets (petite feature UI, bug, tâche floue en deux temps), chacun avec la demande brute de l'utilisateur en entrée. C'est par l'exemple que Pi apprend le niveau de détail attendu.

**Côté OpenCode**, la skill `own-the-task` renforce le même contrat : explorer avant d'éditer, faire un plan court (todo) avant de coder, vérifier chaque critère de fin lui-même, se relire avant d'écrire `REPORT.md`, et signaler honnêtement ce qui n'est pas vérifié plutôt que de le déclarer fini.
### Ce que dit `references/setup.md` (le parcours non-dev)
Ordre de préférence pour les credentials, du moins au plus pénible pour l'utilisateur :

1. **Login par code** (vérifié sur Docker, 1.18.34, sans TTY, sortie redirigée dans un fichier) : le bot lance la commande en background, lit l'URL et le code dans le log, les envoie à l'utilisateur (« ouvre ce lien sur ton téléphone, tape ce code »).
  

- **ChatGPT Plus/Pro** : `opencode auth login -p openai -m "ChatGPT Pro/Plus (headless)"` → `https://auth.openai.com/codex/device` + code. Aucune saisie.
  
- **GitHub Copilot** : `printf '\r' | opencode auth login -p github-copilot` (le `\r` valide « GitHub.com ») → `https://github.com/login/device` + code.
  
- **Anthropic** : clé API uniquement, pas de device flow. Pas de saisie de clé dans le chat → takeover ou (plus tard) gateway.
  
- Sans `-m` / sans réponse, la commande attend indéfiniment sur stdin et ignore SIGTERM : `oc login` doit la lancer avec `setsid` et l'arrêter avec `kill -9` après ~15 min.
  

2. **Takeover** en dernier recours : `request_takeover` avec une raison écrite pour un non-dev, puis 3 étapes exactes (« clique sur le terminal, colle cette ligne, suis les choix »). Le bot reprend et relance `doctor`.
  

Idem pour GitHub (`GH_TOKEN`) : le bot explique où créer le token, en 4 clics, et pourquoi le restreindre aux repos utiles.

* * *
## 4. Actuel vs v2
| | Actuel | v2 |
|---|---|---|
| Format | 1 fichier de 30 lignes, tout chargé | `SKILL.md` court + 5 références chargées à la demande |
| Lancement | `nohup bash -c 'opencode run …'` collé par le modèle | `oc start`, une commande littérale |
| Attente | **poll `sleep 30` dans le tour** → bot occupé, user en steering | rappel `schedule_create`, bot libre tout de suite |
| Parallélisme | non (même checkout) | N jobs, un worktree chacun |
| Permissions OpenCode | défaut : `ask` rejetés en silence, tool calls en échec | config headless livrée, aucun `ask` |
| Suivi / correction | « relance un nouveau run » sans contexte | `oc send` dans la même session |
| Vérification | Pi lit le diff et lance les tests | OpenCode vérifie + relecture par une 2e session ; Pi juge l'intention |
| Fin de job | log brut | `REPORT.md` imposé par la skill `own-the-task` |
| Setup / pannes | « demande à l'utilisateur de lancer `opencode auth login` » | `doctor` + parcours guidé, takeover en dernier recours |
| Arrêt | impossible (`kill` refusé) | `oc stop` |

* * *
## 5. Hors skill (suites, PR séparées)
- **Gateway LLM** (déjà dans `plan/dev-computer-opencode`) : token par computer vers la model connection de l'utilisateur, `opencode.json` pointé dessus. Supprime tout setup credentials. **C'est le vrai déblocage pour un non-dev** ; tant qu'il n'existe pas, le setup reste la partie fragile.
  
- **Réveil instantané** au lieu du rappel : le script appelle le webhook du bot en fin de job. Demande le secret webhook côté computer et que l'API soit joignable depuis le conteneur. À faire si les rappels se révèlent trop lents.
  
- `opencode serve` si on veut suivre un job en direct ou l'interrompre proprement.
  
- **E2B / Daytona / Box** : pas de montage des skills ni d'OpenCode ; `doctor` renvoie `unsupported_computer` et le bot le dit.
  

* * *
## 6. Risques (testés sur Docker le 2026-10-04)
Banc : image `rakazo/computer:filemgr` + binaire OpenCode 1.18.34, commandes passées dans le wrapper exact du superviseur (`timeout --kill-after=1s Ns sh -c …`), faux provider OpenAI-compatible local (réponse après 15 s pour forcer le chevauchement).

1. `timeout` **tue le groupe de process : confirmé.** Commande qui rend la main vite → le `nohup … &` survit. Commande qui dépasse le timeout → le `nohup … &` est tué. Avec `setsid nohup … &` il survit dans tous les cas. → `oc start` lance toujours via `setsid` et rend la main en < 2 s.
  
2. **3** `opencode run` **simultanés : OK.** Même `~/.local/share/opencode` (SQLite WAL), 3 sessions distinctes, aucune erreur busy/locked. Le follow-up `run -s <session>` reprend la bonne session.
  
3. **Skills via le symlink** `~/.config/opencode/skills` **: OK.** `opencode debug skill` liste la skill du dossier lié. `oc doctor` peut utiliser cette commande pour vérifier que `own-the-task` est visible.
  
4. **Login sans TTY : OK pour OpenAI (headless) et GitHub Copilot**, pas pour Anthropic (clé API seule). Détails dans `setup.md` ci-dessus.
  
5. Non testé (image locale sans git) : worktrees git en parallèle. Couvert par le test manuel du §7 sur l'image courante.
  
6. Stop sur le run du bot tue tous les jobs lancés dans ce run (`CANCEL_COMPUTER_RUN_WORK`). Acceptable, mais `talking-to-user.md` doit le dire avant que l'utilisateur appuie.
  
7. Un job qui tourne garde le Team computer éveillé : coût. `status` signale `stalled`, et le rappel arrête tout job > 2 h sans progrès après avoir prévenu.
  
8. Les rappels sont des routines visibles dans l'UI de l'utilisateur. Nom lisible (« Follow-up: contact form ») et auto-annulation à la fin.
  

* * *
## 7. Tests
- `scripts/oc` : test bats/vitest offline avec un faux `opencode` (script qui écrit du NDJSON et sort 0/1) : start/status/result/send/stop/clean, worktrees parallèles, `stalled`.
  
- Guard : chaque commande du `SKILL.md` passe `isProtectedComputerLifecycleCommand` (cas ajouté à `executor-computer-safety.test.ts`).
  
- Manuel, une fois : vrai computer Docker, 2 jobs en parallèle sur un repo jouet, rappel, follow-up, relecture.
  

* * *
## 8. Décisions prises en review
1. **Pas de gateway LLM pour l'instant.** Le setup credentials passe par le login par code, puis takeover en dernier recours. `references/setup.md` est la partie à soigner le plus.
  
2. **Pas de push par défaut.** Branche locale + preview ; `--push` (et `opencode-push.json`) seulement quand l'utilisateur demande une PR.
  
3. **3 jobs simultanés max par computer.** `oc start` refuse le 4e avec `state=busy` ; le bot propose d'attendre ou d'arrêter un job.
  
4. **Tout le contenu des skills est en anglais** (`SKILL.md`, `references/*`, `own-the-task`, messages de `oc`). Le bot parle à l'utilisateur dans sa langue ; les exemples de messages dans `talking-to-user.md` sont en anglais.
