# 03: Renseigner la fenêtre de contexte du modèle depuis le catalogue

**What to build:** La sélection d'historique budgétise en tokens dès qu'elle connaît la fenêtre de contexte du modèle, et retombe sur un nombre fixe de messages sinon. Aujourd'hui cette fenêtre n'est renseignée que pour les credentials de type « OpenAI compatible » : pour Anthropic, OpenAI et OpenRouter — soit la majorité des runs — elle est inconnue, donc l'historique est tronqué à un nombre de messages arbitraire, indépendamment de leur taille.

L'information existe déjà : le catalogue de modèles du runtime pi porte la fenêtre de contexte de chaque modèle, elle n'est simplement pas recopiée dans le modèle résolu pour le run. Ce ticket branche les deux.

Contrainte : rien de spécifique à un provider en dehors des adapters. Le catalogue est déjà une dépendance de l'adapter, pas un nouveau vendor.

**Blocked by:** None (can start immediately)

**Status:** done — mergé en `6c114898`

- [ ] La fenêtre de contexte est résolue depuis le catalogue quand elle n'est pas fournie par le credential
- [ ] Un modèle absent du catalogue garde le comportement actuel (fallback en nombre de messages), sans erreur
- [ ] Les runs Anthropic / OpenAI / OpenRouter passent effectivement en sélection par budget tokens — vérifiable via le mode de sélection logué au ticket 01
- [ ] Test couvrant les trois cas : fenêtre du credential, fenêtre du catalogue, aucune des deux
