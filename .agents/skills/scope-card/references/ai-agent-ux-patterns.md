---
titre: "Patterns UX/UI pour clients d'agents IA - Loi de design du gate Design Rakazo"
date: 2026-09-06
contexte: "Document de référence servant de loi de design au gate Design du pipeline de dev de features Rakazo. Distille les patterns best-in-class des meilleurs clients d'agents IA du marché, traduits pour le design system monochrome + progressive disclosure de Rakazo."
statut: référence vivante
---

# Patterns UX/UI pour clients d'agents IA

> Loi de design du gate **Design** de Rakazo. Toute maquette de feature passe la checklist du §6 avant de partir en code.
> Rakazo est un **client d'agent IA conversationnel multi-surface** (web / desktop Electron / mobile Expo). On se compare aux meilleurs clients d'agents du marché, pas à un site voyage ni à une marque grand public.
> **Règle d'écriture stricte : jamais de tiret cadratin. Tiret simple, virgule, point, ou reformulation.**
>
> **Lecture sélective (ne jamais charger tout le fichier).** Toujours : §1 (principes) et §6 (checklist). Puis seulement les sous-sections des moments que la feature touche : §2.x pour un moment de run, §3.x pour un moment de messagerie, §4.x si la feature est transverse. §5 (anti-patterns) en cas de doute. §7 (sources) jamais au gate. Repérer les sections avec `grep -n '^##' <ce fichier>` puis lire par plage de lignes.

Contraintes DS non négociables rappelées ici parce qu'elles conditionnent chaque pattern :
- **Monochrome** : primary = encre (ink). Statuts = `destructive` / `success` / `warning` uniquement. La **seule couleur d'identité** appartient aux bots.
- shadcn/ui sur Base UI (web/desktop) ; mobile natif-first (Expo UI, sheets/menus/pickers natifs).
- Tokens sémantiques `@rakazo/ui-tokens`. Jamais de hex produit en dur.
- **Minimalisme + progressive disclosure** : la capacité avancée n'apparaît que quand elle devient pertinente. Chaque mot visible est de l'UI ; on commence par ce qu'on peut **retirer**. Le frontend exprime l'intention et rend l'état ; le backend possède l'orchestration.

---

## 1. TL;DR - Les principes non négociables

1. **Rendre l'état, pas des mots sur l'état.** Un composant de statut vaut mieux qu'une phrase qui décrit ce que l'UI montre déjà.
2. **Streamer tout, tout de suite.** Montrer les entrées/sorties d'outils au fil de l'eau est l'amélioration UX au meilleur rendement. Jamais d'attente muette de la réponse complète.
3. **Le plan avant l'exécution, éditable.** Sur les tâches à enjeu, afficher la séquence d'actions et laisser l'humain approuver, modifier ou retirer une étape avant que ça parte.
4. **Progressive disclosure par défaut.** Un résumé d'une ligne ; le détail (payload d'outil, logs, diff complet) est un dépliement optionnel, jamais imposé.
5. **L'humain reste dans la boucle par le risque, pas par principe.** Réversible = auto ; sensible/irréversible = approbation bloquante explicite. Pas de sur-confirmation sur le trivial.
6. **Steering pendant le run est un droit, pas un bug.** L'utilisateur doit pouvoir parler pendant que le bot travaille, voir sa file, et savoir si son message interrompt ou s'ajoute.
7. **Interrompre, pas tout jeter.** Une pause doit permettre de reprendre, pas d'effacer le travail en cours.
8. **Les erreurs se lisent en trois temps :** ce qui s'est passé, pourquoi, quoi essayer maintenant. Jamais de retry générique opaque.
9. **Une couleur = un bot.** L'identité colorée est réservée aux agents. Tout le reste est encre + tokens de statut.
10. **Calme visuel sur densité brute.** L'info dense se replie et se hiérarchise ; on ne noie pas l'utilisateur sous un mur de logs.
11. **Cohérence cross-surface, divergence assumée.** Même modèle mental web/desktop/mobile ; on diverge sur les mécaniques natives (sheets, gestes), jamais sur la sémantique.
12. **Fin de run = résumé + prochaine action.** Un run se termine sur ce qui a changé et le pas suivant, pas sur un silence ou un dernier log.

---

## 2. Les moments clés d'un run d'agent

Format de chaque pattern : **Quoi** (best-in-class) / **Pourquoi** / **Pour Rakazo** (application concrète, DS-compatible).

### 2.1 Lancement / composer / expression d'intention

**Quoi.** Le composer est le point d'entrée unique. Best-in-class (Claude Code, Cursor Composer, Codex) : une zone de saisie sobre + une **sélection de mode** adjacente au bouton d'envoi (Plan / Ask / Auto), le contexte attaché (fichiers, repo) visible mais discret, et zéro décoration. Codex expose son harness comme un flux d'événements stable et pilote l'UI depuis là ; le composer ne fait qu'exprimer l'intention.

**Pourquoi.** L'utilisateur formule une intention, pas une commande. Le mode (planifier vs exécuter directement) est la décision la plus lourde de conséquences ; la mettre à côté du bouton d'envoi la rend consciente sans l'imposer. Le reste (attachements, options avancées) suit la progressive disclosure.

**Pour Rakazo.**
- Composer = une seule zone de texte + bouton d'envoi. Le sélecteur de mode/bot vit **à côté** du bouton, pas dans une barre d'outils pleine.
- Le choix de **bot** porte sa couleur d'identité (pastille) ; c'est le seul endroit coloré du composer.
- Attachements de contexte : chips discrètes en `muted`, dépliables. Pas de panneau permanent tant qu'il n'y a rien d'attaché (empty by default).
- Placeholder = microcopy minimale ("Décris ce que tu veux faire"), pas un tutoriel.
- Progressive disclosure : les options avancées (modèle, sandbox, permissions) sont derrière un dépliement `...` ou un menu natif (sheet sur mobile), jamais étalées.

### 2.2 Affichage du run en cours : streaming, étapes/plan, "ce que fait l'agent maintenant"

**Quoi.** Deux horloges distinctes, à ne pas fusionner : la **cadence conversationnelle** (messages) et la **cadence workflow** (étapes). Les bons clients séparent un fil de messages d'un **panneau d'activité / timeline** qui suit ce qui est fait, en cours, bloqué, à venir. Devin affiche un onglet Planner avec la liste des milestones cochés dynamiquement ; le plan se réajuste au fil des résultats. Le protocole AG-UI standardise ça en ~16 types d'événements (deltas de message, lifecycle du run, événements d'outils, snapshots d'état).

**Pourquoi.** Un agent fait des dizaines d'étapes séquentielles, se met en pause, streame du partiel, forke en sous-tâches. Un fil de chat linéaire ne peut pas rendre ça lisiblement. Le "ce qu'il fait maintenant" maintient la confiance pendant la latence (cf. §4.1).

**Pour Rakazo.**
- **Une ligne d'état vivante** en tête du run : le libellé de l'étape courante ("Lecture des fichiers", "Exécution du test"), en `foreground`/`muted`, mise à jour par le stream. C'est un composant d'état, pas une phrase générée qui répète l'UI.
- **Plan pliable** : si le backend produit un plan, l'afficher en liste verticale d'étapes à une ligne, chaque étape avec un état (à venir / en cours / faite / bloquée) rendu par la typo et une icône monochrome + le token de statut, pas par de la couleur décorative.
- Streaming du texte token par token dans le fil ; les étapes se cochent dans la timeline.
- Progressive disclosure : le plan complet est replié par défaut sur mobile (sheet), déplié sur desktop si l'espace le permet. On ne montre le panneau d'activité que **quand il y a un run multi-étapes** ; un simple Q/R ne le déclenche pas.
- Le "maintenant" appartient au bot : la pastille de couleur du bot marque la ligne d'état active. Un seul accent coloré à l'écran.

### 2.3 Rendu des appels d'outils (tool calls) et de leurs résultats

**Quoi.** Best-in-class : surfacer **quel outil**, **avec quoi** (input) et **ce qu'il retourne**, au moment de la décision, pas noyé dans un log replié après coup. Cacher les tool calls produit des sorties qui "semblent faisantes autorité mais invérifiables". Chaque appel est un bloc compact : nom d'outil + résumé du résultat, dépliable vers le détail. Succès/erreur/sortie longue ont trois traitements distincts.

**Pourquoi.** La vérifiabilité est le socle de la confiance dans un agent. Mais tout montrer en entier = mur illisible. Le compromis best-in-class est le **bloc pliable par défaut fermé** avec l'essentiel visible.

**Pour Rakazo.**
- **Carte d'appel d'outil** = composant `card` sobre : `[icône outil] nom_outil · résumé une ligne du résultat` + chevron de dépliement. Fermée par défaut.
- **Succès** : icône neutre (encre) ou `success` discret (une coche, pas un aplat vert). Le succès est l'état attendu ; il ne crie pas.
- **Erreur** : bordure/pastille `destructive`, résumé de l'erreur en clair, détail dépliable. Voir §2.7 pour la structure en trois temps.
- **Sortie longue** (fichier, JSON, logs) : ne jamais l'étaler dans le fil. Aperçu tronqué (N premières lignes) + "voir tout" qui ouvre un panneau/sheet dédié avec scroll interne. Monospace via token, pas de couleur syntaxique bariolée qui violerait le monochrome (coloration syntaxique acceptable si elle passe par un thème monochrome/ink à faible saturation).
- Grouper les appels répétitifs : "12 fichiers lus" replié en un bloc, pas 12 cartes.
- Progressive disclosure stricte : le payload d'entrée n'apparaît qu'au dépliement.

### 2.4 Approbations / permissions / actions sensibles (l'humain dans la boucle)

**Quoi.** Le meilleur modèle est **tiéré par le risque** (Approval Queues & Escalation) : réversible = auto-approuvé ; risque moyen = revue asynchrone non bloquante ; irréversible = approbation synchrone bloquante. Claude Code : modes Plan / Ask / Auto, et en Auto un classifieur séparé bloque ce qui dépasse la demande ou vient de contenu hostile. Règle clé : une demande d'approbation qui **inclut le contexte accumulé** obtient des décisions humaines plus rapides et justes qu'un "approuver/refuser" sec.

**Pourquoi.** Sur-confirmer tue le bénéfice de l'agent ; sous-confirmer détruit la confiance sur l'irréversible. Le bon design route par réversibilité, pas par un gate uniforme.

**Pour Rakazo.**
- **Prompt d'approbation contextuel** : la carte de permission montre l'action exacte (commande, fichier écrit, requête réseau), pourquoi elle est demandée, et le diff/l'effet attendu si applicable. Boutons : `Approuver` (primary/ink), `Refuser` (`destructive` en variante outline/ghost, pas un bloc rouge plein).
- **Tiérage** : réversible passe sans prompt (mode auto) ; sensible (suppression, écriture hors sandbox, réseau, dépense) = carte bloquante. Le niveau est une décision **backend** ; le frontend rend seulement l'état "en attente d'approbation".
- **Délégation progressive** : proposer "toujours autoriser cet outil dans cette session" après quelques approbations, jamais imposé au premier run. La confiance se gagne, l'autonomie s'élargit au rythme de l'utilisateur.
- Mobile : approbation via **sheet natif** avec actions claires, jamais un petit bouton perdu dans le fil.
- Pas de sur-confirmation : lire un fichier, streamer du texte, ne demande jamais d'approbation.
- L'état "run en pause, attend ton feu vert" doit être **impossible à rater** (bandeau en tête de run, pastille du bot en `warning`), sinon l'utilisateur ne sait pas pourquoi rien n'avance.

### 2.5 Message de l'utilisateur PENDANT un run (steering en cours d'exécution)

**Sujet chaud pour Rakazo.** C'est le point où les clients actuels échouent le plus, donc la plus grosse opportunité de différenciation.

**Quoi (et ce qui ne marche pas).** Claude Code illustre le piège : taper Entrée pendant un run **met en file** sans que ce soit clair, l'utilisateur croit interrompre ; pour vraiment rediriger il faut Ctrl+C, ce qui **jette le travail en cours**. Sur les longs tours, les messages en attente ne sont traités qu'à la fin et peuvent être perdus à la déconnexion. Les demandes utilisateurs convergent vers : un **canal de steering prioritaire**, une **file visible/éditable**, et le choix explicite interrompre vs ajouter. Le bon modèle conceptuel : **mixed-initiative** (le contrôle passe fluidement entre humain et agent) et **interruption reprenable** (AG-UI : annulation + reprise, on ne repart pas de zéro).

**Pourquoi.** Séparer les deux horloges (§2.2) impose de décider ce que fait un message envoyé pendant un run. L'ambiguïté "ça a interrompu ou pas ?" est la pire expérience : l'utilisateur ne sait pas si le bot l'a entendu.

**Pour Rakazo.**
- **Rendre l'intention explicite au moment de l'envoi.** Pendant un run, le composer affiche l'effet de l'envoi : par défaut **"Ajouter à la file"** (steering doux, l'agent l'intègre au prochain point d'arrêt) avec une action secondaire **"Interrompre et rediriger"** (steering dur). Deux affordances distinctes, jamais un seul Entrée ambigu.
- **File de steering visible et éditable** : les messages en attente s'affichent en tête de run (chips `muted`), supprimables un par un avant d'être consommés. L'utilisateur voit que son message a été reçu.
- **Interruption reprenable** : "Interrompre" met en pause proprement (checkpoint), n'efface pas le contexte, et laisse reprendre. Distinguer clairement **Pause/redirect** (reprenable) de **Stop** (`destructive`, termine le run).
- **Accusé de réception immédiat** : dès l'envoi, feedback visuel que le message est en file ou a interrompu. Zéro latence perçue sur cet accusé (optimiste), même si le traitement suit.
- Progressive disclosure : "Interrompre et rediriger" n'apparaît que **pendant** un run ; hors run, le composer est standard.
- Sémantique identique cross-surface ; sur mobile l'action secondaire peut vivre dans un menu long-press ou un sheet, mais le "ajouter vs interrompre" reste explicite.

### 2.6 Diffs, artefacts, fichiers produits

**Quoi.** Cursor et Windsurf font du **diff-and-approve** un objet de première classe : l'agent décrit, édite, montre un diff, l'utilisateur approuve avant que ça touche `main`. Cursor rend le diff côte à côte, multi-fichiers, dans l'UI même. Claude Code / Cowork : les artefacts (fichiers, docs, tableurs) sont des livrables inspectables, produits dans une sandbox isolée pour réduire le blast radius. v0 / génération d'UI : l'artefact est un rendu live à côté du prompt.

**Pourquoi.** Le diff est le contrat de confiance sur une action irréversible (écrire du code, un fichier). Le voir avant qu'il "atterrisse" est une feature, pas un frein : on attrape les cas limites que l'agent rate.

**Pour Rakazo.**
- **Artefact = objet distinct du fil**, pas un pavé de texte inline. Carte d'artefact (nom, type, taille, statut) qui ouvre un panneau/viewer dédié.
- **Diff** : ajouts/suppressions rendus par la **structure** (fond `muted` pour supprimé, encre pleine pour ajouté) + les tokens `success`/`destructive` en **liseré/marge**, pas en aplats colorés saturés qui casseraient le monochrome. Le vert/rouge classique du diff se traduit en : liseré fin de statut + fond très désaturé. La lisibilité vient du contraste de densité, pas de la couleur.
- **Approbation d'application** : "Appliquer" (primary) vs "Rejeter" ; jamais d'écriture silencieuse d'un fichier sans que le diff ait été montrable.
- Multi-fichiers : liste pliable de fichiers changés + compteur (`+42 / -13`), chaque fichier dépliable. On ne déroule pas 10 diffs d'un coup.
- Mobile : diff en viewer plein écran avec scroll horizontal interne (jamais de scroll horizontal de la page). Sur petit écran, privilégier la vue unifiée à la vue côte à côte.
- Artefacts produits (export, doc) : action de téléchargement/ouverture explicite, statut "prêt".

### 2.7 Erreurs, échecs, reprise/retry, états dégradés

**Quoi.** Best-in-class = **message d'échec structuré en trois parties** : ce qui s'est passé / pourquoi / quoi essayer. Le retry générique traite toutes les erreurs pareil et c'est le chemin le plus court vers l'abandon. **Recovery routing** : router selon le type d'échec (requête mal comprise -> re-montrer le prompt d'origine ; échec d'outil -> montrer la frontière de l'outil ; succès partiel -> traitement différent d'un échec total).

**Pourquoi.** Un agent échoue régulièrement (outil indisponible, timeout, mauvaise interprétation). La qualité de l'UX se juge surtout dans l'échec. Un échec silencieux ou cryptique bloque et fait fuir.

**Pour Rakazo.**
- **Carte d'erreur** en `destructive` (liseré/icône, pas aplat) structurée : titre = ce qui a échoué ; corps = cause en clair ; action = 1 à 2 boutons de récupération **spécifiques** au type d'échec, pas un "Réessayer" nu.
- **Succès partiel** : état dédié (`warning`), résumé de ce qui a marché vs ce qui reste, action pour finir seulement le reste.
- **États dégradés** : si un outil/modèle est indisponible, le dire explicitement et proposer l'alternative, sans faire semblant.
- **Reprise** : après une pause ou une erreur récupérable, reprendre depuis le point d'arrêt (cf. §2.5), pas re-run complet.
- Détail technique de l'erreur (stack, logs) : replié par défaut, dépliable pour qui veut debugger. Pas de mur de stack trace imposé.
- Jamais de spinner opaque qui masque un échec : un run qui n'avance plus doit basculer en état d'erreur explicite après timeout.

### 2.8 Fin de run : résumé, prochaine action, historique

**Quoi.** Devin termine sur un livrable (PR ou handoff). Les bons clients closent un run sur un **résumé de ce qui a changé** + la **prochaine action suggérée**, pas sur le dernier log. L'historique du run reste consultable (timeline, artefacts, décisions).

**Pourquoi.** L'utilisateur a délégué ; à la fin il veut savoir le résultat et quoi faire ensuite, pas relire 40 étapes. Le résumé referme la boucle de confiance.

**Pour Rakazo.**
- **Bloc de clôture** : 1 à 3 lignes de résumé (ce qui a été fait/changé) + liste des artefacts produits + **prochaine action** proposée sous forme d'actions cliquables (chips), pas de paragraphe.
- L'état de la ligne vivante (§2.2) bascule en "Terminé" (statut neutre/`success` discret) ; la timeline se fige, consultable.
- **Historique** : le run devient une entrée d'historique repliée (titre + horodatage + bot), ré-ouvrable en entier. On ne garde pas tout déplié dans le fil.
- Pas de texte de politesse qui répète l'UI ("J'ai terminé la tâche avec succès !"). Le composant d'état dit "Terminé" ; le résumé dit le fond.

### 2.9 États vides (empty states) et onboarding progressif

**Quoi.** OEP (Onboarding & Education) : introduire les capacités et **construire le bon modèle mental** ; lancer un agent sans poser d'attentes fait croire à de la magie. Best practice = onboarding progressif, pas un tour bloquant. L'empty state est le premier écran d'apprentissage.

**Pourquoi.** Un client d'agent est un objet nouveau ; sans repères l'utilisateur ne sait ni quoi demander ni ce que le bot peut faire. Mais un onboarding lourd contredit le minimalisme.

**Pour Rakazo.**
- **Empty state du composer** : quelques amorces d'intention concrètes (2 à 4 exemples cliquables typés du bot courant), sobres, en `muted`. Pas d'illustration décorative bavarde.
- **Découverte progressive** : les capacités avancées (modes, outils, multi-bots) se révèlent quand elles deviennent pertinentes, pas dans un tour d'intro. Ex : la file de steering ne s'explique qu'au premier run long.
- **Modèle mental honnête** : dire ce que le bot peut/ne peut pas faire au bon moment (ex : première action sensible -> expliquer le système de permissions une fois).
- Empty state de liste (pas de runs, pas d'artefacts) : une phrase + l'action primaire. Rien de plus.
- Onboarding = jamais bloquant, toujours dismissable, jamais répété.

### 2.10 Multi-bots / multi-agents (identité visuelle, une couleur par bot)

**Quoi.** Cowork décompose une tâche en sous-agents parallèles à contextes propres qui remontent des résultats distillés. Agent Collaboration UX : les **handoffs doivent être transparents** ; un passage de relais silencieux perd l'utilisateur ("qui agit là ?"). Cursor gère la "state explosion" du multi-agent par un command center (chaque tâche a ses fichiers, PRs, logs, previews).

**Pourquoi.** Dès qu'il y a plusieurs bots/sous-agents, l'utilisateur doit savoir en permanence **qui parle** et **qui agit**. C'est exactement ce que la couleur d'identité par bot résout dans le DS monochrome.

**Pour Rakazo.**
- **Une couleur = un bot**, appliquée avec parcimonie : pastille/avatar, liseré du message, marqueur de la ligne d'état active. Le corps du message reste encre. La couleur **identifie**, elle ne décore pas.
- **Handoff explicite** : quand un bot passe la main à un autre (ou spawn un sous-agent), un marqueur clair dans la timeline (couleur A -> couleur B), jamais silencieux.
- **Sous-agents parallèles** : chaque sous-tâche est une ligne/carte pliable sous le bot parent, avec son état propre. Éviter la state explosion : vue repliée par défaut, compteur ("3 sous-tâches en cours").
- Accessibilité : la couleur du bot n'est **jamais** le seul canal d'identité (toujours doublée du nom/avatar), pour daltoniens et contraste (cf. §4.4).
- Cohérence : la couleur d'un bot est stable dans toute l'app et sur les 3 surfaces.

---

## 3. Le meilleur des messageries (Slack, WhatsApp, Telegram, iMessage)

Rakazo est autant une messagerie qu'un client d'agent (Rakazo est né comme un bot Telegram). Deux familles de moments cohabitent : le **run** (§2) et la **conversation**. On prend le meilleur de chaque app, jamais leur surcharge. Tout se traduit dans le DS monochrome : l'accent coloré reste réservé à l'identité d'un bot.

### 3.1 Composer et saisie
**Best-of.** iMessage (la saisie ne vole jamais l'écran), Slack (formatage riche en progressive disclosure, pas de barre d'outils permanente), Telegram (envoi optimiste, rapidité perçue).
**Pour Rakazo.** Composer minimal ; formatage et pièces jointes révélés au besoin ; envoi optimiste (le message apparaît aussitôt en état "en cours d'envoi"). Rien qui encombre au repos.

### 3.2 États de remise = états de run (une seule horloge côté message)
**Best-of.** WhatsApp (ticks envoyé / remis / lu), iMessage (Distribué / Lu, discret).
**Pour Rakazo.** Réutiliser cette grammaire pour un agent : envoyé → reçu → **en traitement** → répondu. Les états de remise d'une messagerie et l'état d'un run (§2.2) sont le **même** système, monochrome (encre + pastille de statut). Jamais deux vocabulaires concurrents pour dire "où en est mon message".

### 3.3 Groupement, temps, densité
**Best-of.** iMessage/WhatsApp (messages groupés par émetteur, horodatage par paquets), Telegram (séparateurs de date discrets, marqueur "nouveaux messages").
**Pour Rakazo.** Grouper les messages consécutifs d'un même bot ; horodatage au survol ou par bloc, pas par ligne ; un séparateur "nouveaux messages" au retour. Calme visuel avant tout.

### 3.4 Fils / threads
**Best-of.** Slack (un thread isole une sous-conversation sans polluer le canal).
**Pour Rakazo.** Un run long ou une sous-tâche part en thread ou panneau dédié plutôt que d'inonder le fil. C'est la matérialisation des deux horloges (§2.2) : la conversation reste lisible, le workflow détaillé vit à côté.

### 3.5 Réactions et feedback léger
**Best-of.** iMessage (tapbacks en un geste), Slack (émoji comme signal ou action).
**Pour Rakazo.** Réactions légères sur les messages du bot (valider, pouce, "à refaire") : un signal en un geste, sans écrire, qui alimente aussi la boucle de feedback produit. Tapbacks en encre, l'accent reste à l'identité du bot.

### 3.6 Actions rapides et claviers inline (très pertinent pour Telegram)
**Best-of.** Telegram bots (inline keyboards : boutons suggérés sous un message).
**Pour Rakazo.** Proposer des actions tappables sous un message du bot (réponses suggérées, choix, confirmations). C'est le canal naturel du steering (§2.5) et des approbations (§2.4) : un tap plutôt qu'une phrase. Chips monochromes, jamais un mur de boutons.

### 3.7 Présence et activité
**Best-of.** iMessage/WhatsApp (bulle de frappe "en train d'écrire").
**Pour Rakazo.** L'équivalent enrichi : "le bot travaille" **avec le quoi** (§2.2), pas un simple "…". La présence entretient la confiance pendant la latence.

### 3.8 Épingles, sauvegarde, recherche
**Best-of.** Telegram/Slack (épingler un message clé, messages sauvegardés, recherche rapide).
**Pour Rakazo.** Épingler un artefact ou un résultat important en tête de conversation ; retrouver un run passé. Le résultat d'un agent a une valeur durable : ne pas le laisser défiler dans l'oubli.

### 3.9 Notifications : alerter juste
**Best-of.** Telegram (messages silencieux, granularité fine), Slack (mention vs canal), iMessage (retenue).
**Pour Rakazo.** N'alerter que quand le bot a besoin de l'humain : approbation, fin d'un run long, échec. Le reste est silencieux. Une notification = une raison.

### 3.10 Retenue sur les effets
**Best-of.** iMessage sait faire des effets mais les dose ; les bons clients n'animent pas gratuitement.
**Pour Rakazo.** Aucune animation décorative. Le mouvement sert l'information (progression, apparition d'un résultat), jamais le spectacle. Cohérent avec le calme monochrome.

---

## 4. Patterns transverses

### 4.1 Latence perçue & feedback

- **Feedback optimiste immédiat** sur toute action utilisateur (envoi, approbation, steering) : l'accusé de réception ne doit jamais attendre le backend.
- **Statut proactif** pendant le travail : dire ce qui se passe ("Recherche dans 3 sources", "Comparaison de 14 options") maintient la confiance dans le délai. Mais c'est un **libellé d'état issu du stream**, pas une phrase générée qui paraphrase l'UI.
- **Skeletons plutôt que spinners** quand la forme du résultat est connue. Un spinner nu = boîte noire.
- Jamais de spinner sans issue : après timeout, basculer en erreur explicite (§2.7).
- Le premier token/la première étape doit apparaître vite ; le streaming est le meilleur anti-latence perçue.

### 4.2 Densité d'information vs calme visuel

- **Progressive disclosure comme réglage de densité** : résumé dense en surface, détail à la demande. Le calme vient du repli, pas de l'appauvrissement.
- Regrouper le répétitif (N appels d'outils, N fichiers) en un bloc compté.
- Hiérarchie par **typo + espace + un seul accent** (le bot), pas par multiplication de couleurs ou de bordures.
- "Traiter chaque mot comme de l'UI" : avant d'ajouter un label, se demander ce qu'on peut retirer. Un composant d'état > une phrase.
- Le mur de logs est un anti-pattern (§5). Logs = repliés, scroll interne, jamais dans le flux principal.

### 4.3 Cohérence cross-surface (web / desktop / mobile) et quand diverger

- **Invariant : la sémantique.** Mêmes états, mêmes noms, mêmes décisions (ajouter vs interrompre, approuver vs refuser, appliquer vs rejeter) partout. Le desktop Electron héberge l'UI web : parité quasi totale attendue.
- **Diverger sur la mécanique native, pas sur le sens** : mobile Expo utilise sheets, menus contextuels, pickers **natifs** ; approbations et options avancées passent en bottom sheet ; le long-press remplace le survol.
- **Densité adaptée** : desktop peut montrer plan + fil côte à côte ; mobile replie le plan en sheet et privilégie une colonne.
- **Pas de scroll horizontal de page** sur mobile : diffs/tableaux/code scrollent dans leur propre conteneur.
- Tokens `@rakazo/ui-tokens` partagés = cohérence visuelle garantie ; ne jamais recoder une couleur en dur pour "adapter" une surface.

### 4.4 Accessibilité

- **Nom accessible sur tout élément d'action** : les cartes d'outil, boutons d'approbation, chevrons de dépliement portent un label (pas juste une icône).
- **La couleur n'est jamais le seul porteur d'info** : statut = icône + texte + token ; identité de bot = couleur **+** nom/avatar. Indispensable vu qu'on a peu de couleurs et qu'elles sont sémantiques.
- **Contraste** : vérifier `foreground`/`muted`/`destructive` sur `background`/`card` en AA. Le monochrome facilite le contraste mais le `muted` sur `muted` est un piège.
- **Focus visible et ordre logique** : le focus suit la lecture (composer -> plan -> approbations). Le steering doit être atteignable au clavier.
- **Régions live** : la ligne d'état et l'arrivée de messages annoncés aux lecteurs d'écran (aria-live poli), sans spammer à chaque token.
- **Cibles tactiles >= 44px** sur mobile (approbations surtout).

### 4.5 Copie / microcopy

- **Le moins de mots possible.** Binaire "confiant/incertain" bat "73% confiant" : l'utilisateur décide plus vite.
- **Ne jamais répéter l'UI en texte.** Si un composant "Terminé" existe, pas de "J'ai fini avec succès".
- Boutons = **verbes d'action** (Approuver, Rejeter, Appliquer, Interrompre), pas "OK/Annuler" génériques.
- Erreurs = phrases humaines actionnables, pas de codes bruts en surface.
- **Jamais de tiret cadratin** dans la microcopy produit non plus. Règle DS + règle utilisateur.
- Ton : sobre, direct, aligné sur le minimalisme. Pas d'emoji de statut, pas d'exclamations.

---

## 5. Anti-patterns (avec la correction)

| Anti-pattern | Pourquoi c'est mauvais | Correction Rakazo |
|---|---|---|
| **Chrome de statut inutile** (badges, bandeaux, "en cours..." partout) | Bruit visuel, dilue le vrai signal | Une seule ligne d'état vivante par run + tokens de statut ciblés |
| **Texte qui répète l'UI** ("J'ai lancé la recherche", "Voici le résultat ci-dessous") | Redondance, coût de lecture | Le composant rend l'état ; le texte ne dit que le fond nouveau |
| **Sur-confirmation** (approuver une lecture, un scroll) | Tue le bénéfice d'agent, fatigue de décision | Tiérage par risque : réversible = auto ; sensible = bloquant |
| **Spinner opaque** sans libellé ni issue | Boîte noire, angoisse pendant la latence | Statut proactif + skeleton + bascule erreur au timeout |
| **Mur de logs** déroulé dans le fil | Illisible, noie le résultat | Logs repliés, scroll interne, aperçu tronqué + "voir tout" |
| **Steering ambigu** (Entrée = file ou interruption ?) | L'utilisateur ne sait pas s'il a été entendu | Affordances explicites "Ajouter à la file" vs "Interrompre" + accusé immédiat |
| **Interruption destructive** (Stop jette tout) | Perte de travail, dissuade d'intervenir | Pause reprenable (checkpoint) distincte du Stop `destructive` |
| **Tool calls cachés** | Sorties invérifiables, fausse autorité | Carte d'outil pliable, résultat inspectable |
| **Diff appliqué en silence** | Confiance rompue sur l'irréversible | Diff montrable + Appliquer/Rejeter explicites |
| **Retry générique** sur toute erreur | Traite tous les échecs pareil, fait abandonner | Erreur en 3 temps + action de récupération typée |
| **Couleur décorative** (accents, dégradés produit) | Casse le monochrome, dilue l'identité des bots | Couleur réservée aux bots ; reste en encre + tokens |
| **Handoff silencieux** entre agents | "Qui agit ?" perdu | Marqueur de handoff explicite dans la timeline |
| **Onboarding bloquant** / tour imposé | Contredit le minimalisme, agace | Empty states apprenants + découverte progressive dismissable |
| **Hex en dur** pour "ajuster" une surface | Casse la cohérence et le theming | Toujours `@rakazo/ui-tokens` |
| **Fin de run muette** (dernier log = fin) | L'utilisateur ne sait pas le résultat ni la suite | Bloc de clôture : résumé + artefacts + prochaine action |

---

## 6. Checklist de gate Design

À passer sur toute maquette de feature Rakazo **avant de coder**. Cocher = conforme.

**Fondations DS**
- [ ] Zéro hex en dur : toutes les couleurs viennent de `@rakazo/ui-tokens`.
- [ ] Seule la couleur d'identité d'un **bot** est colorée ; le reste est encre + statuts (`destructive`/`success`/`warning`).
- [ ] Statuts et identité bot ne reposent **jamais** sur la couleur seule (icône/texte/nom en doublon).
- [ ] Mobile : composants natifs (sheets/menus/pickers) là où c'est attendu ; pas de portage brut du web.

**Minimalisme & progressive disclosure**
- [ ] J'ai listé ce que je peux **retirer** de l'écran avant d'ajouter.
- [ ] Détail lourd (payload d'outil, logs, diff complet, plan) replié par défaut, dépliable.
- [ ] Aucun texte ne répète ce qu'un composant d'état montre déjà.
- [ ] Les capacités avancées n'apparaissent que quand elles deviennent pertinentes.

**Run & streaming**
- [ ] Une ligne d'état vivante dit "ce que fait l'agent maintenant" (issue du stream, pas paraphrase).
- [ ] Le contenu streame au fil de l'eau ; pas d'attente muette de la réponse complète.
- [ ] Si multi-étapes : plan/timeline lisible, états d'étape clairs, séparé de la cadence des messages.

**Tool calls & artefacts**
- [ ] Chaque appel d'outil est inspectable (nom + résultat + détail dépliable).
- [ ] Sortie longue tronquée avec "voir tout" en panneau dédié, pas dans le fil.
- [ ] Diff montrable avant application ; Appliquer/Rejeter explicites ; rendu monochrome (liseré de statut, fonds désaturés).

**Humain dans la boucle & steering**
- [ ] Actions sensibles/irréversibles = approbation bloquante avec **contexte** (action exacte + effet).
- [ ] Pas de sur-confirmation sur le réversible.
- [ ] Pendant un run : envoyer un message a un effet **explicite** (Ajouter à la file vs Interrompre) + accusé immédiat.
- [ ] File de steering visible/éditable ; interruption **reprenable** distincte du Stop.
- [ ] État "en attente d'approbation / en pause" impossible à rater.

**Erreurs & fin**
- [ ] Erreurs en 3 temps (quoi / pourquoi / quoi faire) avec action de récupération typée, pas un retry nu.
- [ ] Succès partiel a son état dédié.
- [ ] Fin de run : résumé + artefacts + prochaine action ; run archivable/consultable.

**Transverse**
- [ ] Feedback optimiste immédiat sur chaque action ; skeletons plutôt que spinners nus.
- [ ] Sémantique identique web/desktop/mobile ; divergences limitées à la mécanique native.
- [ ] Pas de scroll horizontal de page (mobile) ; conteneurs scrollables internes.
- [ ] Focus clavier logique, cibles tactiles >= 44px, régions live pour l'état.
- [ ] Microcopy minimale, verbes d'action sur les boutons, **aucun tiret cadratin**.
- [ ] Empty state apprenant et sobre ; onboarding non bloquant.

**Conversation / messagerie**
- [ ] Un seul système d'états couvre remise ET run (envoyé/reçu/en traitement/répondu), monochrome, sans double vocabulaire.
- [ ] Envoi optimiste : le message de l'utilisateur apparaît instantanément.
- [ ] Messages consécutifs d'un même bot groupés ; horodatage par bloc, pas par ligne.
- [ ] Un run long ou une sous-tâche peut partir en thread/panneau sans polluer le fil.
- [ ] Actions rapides tappables (réponses suggérées, confirmations) là où un tap vaut mieux qu'une phrase.
- [ ] Réactions légères (tapback) sur les messages du bot, en encre.
- [ ] Notifications : le bot n'alerte que quand il a besoin de l'humain ; le reste est silencieux.
- [ ] Aucune animation décorative ; le mouvement ne sert que l'information.

---

## 7. Sources

Recherche web menée le 6 septembre 2026. Distinction analyse de design vs factuel indiquée.

**Factuel (produits, comportements documentés) :**
- [Claude Code - Desktop application (docs)](https://code.claude.com/docs/en/desktop) - modes Plan/Ask/Auto, sélecteur de mode près du composer, status bar.
- [Anthropic - How we built Claude Code auto mode](https://www.anthropic.com/engineering/claude-code-auto-mode) - classifieur de sécurité séparé qui bloque les actions hors-périmètre ou issues de contenu hostile.
- [Claude Code issues #30492 / #36326 / #64624 / #77537 / #73118 (GitHub)](https://github.com/anthropics/claude-code/issues/30492) - échecs réels du steering mid-run : Entrée ambigu (file vs interruption), Ctrl+C destructif, messages en attente perdus, demande de file éditable. Matière directe du §2.5.
- [OpenAI - Unlocking the Codex harness: the App Server](https://openai.com/index/unlocking-the-codex-harness/) - harness exposé en flux d'événements stable pilotant l'UI.
- [DeployHQ - Cursor 2026: Composer, Agent Mode](https://www.deployhq.com/guides/cursor) et [DigitalApplied - Cursor 3 Deep Dive](https://www.digitalapplied.com/blog/cursor-3-deep-dive-agents-composer-review-2026) - diff-and-approve de première classe, command center, state explosion multi-agent.
- [Zed Agent Panel and UI (DeepWiki)](https://deepwiki.com/zed-industries/zed/8.1-agent-panel-and-ui) et [Warp Agent](https://www.warp.dev/agents/warp-agent) - agent invité dans l'état de l'éditeur / terminal, surfaces opposées.
- [Vercel - AI SDK 3.0 Generative UI](https://vercel.com/blog/ai-sdk-3-generative-ui) - primitives de streaming d'UI générative (createStreamableUI/Value).
- [Anthropic Cowork (guides & analyses)](https://aifordevelopers.substack.com/p/the-complete-guide-to-claude-cowork) - sous-agents parallèles à contexte propre, sandbox isolée, plug-ins (skills/connectors/commands/sub-agents).
- [Medium - Devin 2.0 technical design](https://medium.com/@takafumi.endo/agent-native-development-a-deep-dive-into-devin-2-0s-technical-design-3451587d23c0) - Interactive Planning, onglet Planner, plan réajusté dynamiquement, intervention à tout moment.

**Analyse de design (catalogues et retours de terrain, à pondérer) :**
- [Agentic Design - UI/UX Patterns](https://agentic-design.ai/patterns/ui-ux-patterns) - catalogue de patterns (ASP, HITL, AQE, HOTL, MIP, PDP, ERP, OEP...) avec anti-patterns. Ossature des §2 à §5.
- [Fuselab Creative - UI Design for AI Agents in 2026](https://fuselabcreative.com/ui-design-for-ai-agents/) - patterns concrets : status proactif, timeline workflow vs chat, plan visible éditable, tool-use disclosure, confiance binaire, erreur en 3 temps, délégation progressive. Très actionnable.
- [Zylos Research - Agentic UX frontend patterns 2026](https://zylos.ai/research/2026-05-28-agentic-ux-frontend-design-patterns-ai-agents/) - deux horloges (conversation vs workflow), streaming tool I/O comme plus haut ROI, approbations avec contexte.
- [Magentic-UI - Human-in-the-loop agentic systems (arXiv)](https://arxiv.org/pdf/2507.22358) - cadre académique HITL, checkpoints d'approbation, override.
- [Towards AI - 7 design patterns for AI agents 2026](https://pub.towardsai.net/the-7-design-patterns-every-ai-agent-developer-should-know-in-2026-c77f28b51565) et [AI UX Playground - HITL for AI agents](https://aiuxplayground.substack.com/p/how-to-design-human-in-the-loophitl) - interrupt-based vs async-review HITL, reprise après interruption.
- [Google Developers - AG-UI / A2UI generative UI](https://developers.googleblog.com/a2ui-v0-9-generative-ui/) - protocole d'événements (run lifecycle, message streaming, tool calls, annulation/reprise) qui structure le rendu live et le feedback dans la boucle.

> Note d'honnêteté : les sources "analyse de design" sont des synthèses d'agences/chercheurs, pas des specs officielles ; elles convergent fortement, ce qui renforce la confiance, mais restent des recommandations à confronter à nos propres tests utilisateurs Rakazo. Les sources "factuel" décrivent des comportements produits observés à septembre 2026 et peuvent évoluer.
