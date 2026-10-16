# Relance de check-in après 30 appels d'outils sans message_user
## Pourquoi
Depuis que `message_user` est le seul canal d'un bot de premier niveau (`executor.ts:984`), un run long qui enchaîne les outils sans l'appeler reste muet pour la personne. Elle voit seulement la ligne d'activité. Une relance interne, envoyée au modèle après 30 appels d'outils sans contact, lui rappelle de donner un point d'étape.
## Ce qui existe déjà
- `agent.steer` met un message en file, et Pi le lit juste après `turn_end`, avant le tour suivant. Aucun nouveau mécanisme de middleware n'est nécessaire.
  
- `turn_end` (`pi-runtime.ts:401`) connaît les noms des outils appelés à chaque tour. Le compteur s'y met à jour.
  
- `MAX_SILENT_TOOL_CONTINUATIONS` (`pi-runtime.ts:133`) est le précédent direct : un prompt interne borné, non persisté, en mémoire du process.
  
- Le ticket 08 (`.scratch/grok-harness-close-the-gap/issues/08-…`) borne un run par pas. Ici on ne stoppe rien. On relance seulement. Les deux restent séparés.
  
## Forme des données
```ts
let toolCallsSinceContact = 0; // appels d'outils depuis le dernier contact, local au run
```

Une étape = un appel d'outil, pas un tour Pi. Un tour peut contenir plusieurs appels parallèles, et le ticket 08 compte aussi en appels d'outils. Même unité partout.

Contact = un appel à `message_user`, `ask_user`, `request_secret` ou `request_takeover`. Les trois derniers mettent une question devant la personne, ce qui vaut un check-in.
## Comportement
1. Actif seulement quand `freeTextIsPrivate` est vrai (`executor.ts:1609`) : bot de premier niveau, run déclenché par une personne. Jamais pour une routine, un sous-bot, un helper ou un run `bot_message`. Le runtime reçoit déjà ce drapeau, et l'executor le coupe pour les runs de canal de groupe.
  
2. Chaque appel d'outil terminé incrémente `toolCallsSinceContact`. Un contact le remet à 0.
  
3. Au `turn_end`, si `toolCallsSinceContact >= 30`, on `steer` un message interne et on remet le compteur à 0. La relance suivante arrive donc au plus tôt 30 appels plus tard.
  
4. Le message est un rappel, pas un ordre de bavarder. Brouillon :
  
  > Harness note, not from the user: you have run {n} tool calls since the user last heard from you. Send them a short progress update with message_user (what you found, what is next), then continue.
  
5. Le message reste en mémoire du run. Il n'est ni persisté dans le thread ni compté comme du steering de la personne (`seenSteeringIds` ne le voit pas).
  
6. Compteur local au process, comme `toolCallBudgetsByRun`. Une reprise sur un autre worker passe par `waiting_input`, donc par un contact. Repartir de 0 y est correct.
  
## Pourquoi pas forcer `tool_choice`
Forcer `tool_choice: message_user` dépend du fournisseur et de son support de tool_choice nommé. Ça contredit la règle des providers neutres d'AGENTS.md. Le steer marche sur tout fournisseur compatible.
## Seuil
30, choisi par le mainteneur. Pour l'ajuster ensuite, mesurer sur les traces Langfuse la distribution du nombre d'appels d'outils entre deux `message_user` dans les runs de personne depuis la PR qui a fait de `message_user` le seul canal. Prendre un seuil au-dessus du p90, pour que la relance ne touche que les runs vraiment muets. Constante plateforme d'abord. Pas de réglage par bot ni de variable d'env tant qu'aucun besoin réel n'existe.
## Tests (offline, déterministes)

- 65 appels sans contact → 2 relances.
- `message_user` puis `ask_user` remettent le compteur à 0, et un tour à 2 appels parallèles en compte 2.
- Run dont le texte n'est pas privé → aucune relance.

## Hors périmètre

- Arrêter un run trop long (ticket 08).
- Renommer `message_user`.
