# 07: Déclarer le fournisseur de décision comme destinataire de données

> **Retiré (2026-09-26, décision du mainteneur).** L'usage `decision` et tout ce qui le concerne (divulgation, destinataire dérivé, tests, doc de revue) ont été supprimés d'ai-consent ; le fournisseur de décision n'est pas listé dans le partage de données IA. Le texte ci-dessous est historique.
>
> ~~**Livré en version minimale (lot 1, 2026-09-26).**~~ Usage `decision`, divulgation et destinataire dérivé de la connexion ; porte mobile existante. **Pas** de porte serveur `not_consented`, **pas** d'avance d'`AI_DISCLOSURE_VERSION` (décision du mainteneur). Écarts en fin de ticket.

**What to build:** Un utilisateur qui regarde « Partage de données IA » voit le fournisseur de décision à côté du modèle, de la voix et de la mémoire, avec ce qui lui est envoyé ; sur mobile, la permission est demandée avant qu'une action l'utilise ; ~~et un utilisateur qui n'a pas accordé cette permission fait tourner ses bots exactement comme avant, sans fournisseur de décision, sans erreur.~~

## Pourquoi c'est mécanique

`docs/ai-data-sharing-review.md` et `packages/contracts/src/ai-consent.ts` posent le mécanisme : un vocabulaire d'usages clos — `AiDataUseSchema = model | voice | memory` (`ai-consent.ts:5`) —, une divulgation par usage (`AI_DATA_DISCLOSURES`), des destinataires dérivés de la configuration réelle (`apps/api/src/ai-consent.ts`), un statut par utilisateur, espace et version de divulgation, et une porte côté mobile avant l'action.

Le `state` des tickets 04 et 05 contient des noms d'éléments, ~~des valeurs de champs,~~ des URL, des titres ~~et un début de texte de page~~ (*livré par 04 : URL, titre, rôle et nom des liens, onglets et champs texte, description de cible*). Ce sont des données de la page que le bot visite — potentiellement un back-office client, une boîte mail, un CRM. Le modèle principal les reçoit déjà (la divulgation `model` cite « screenshots » et « connected-app content »), mais un fournisseur de décision est un **second destinataire** de la même classe de données, avec son propre contrat, sa propre rétention. Il entre donc dans le mécanisme comme les autres, ni plus ni moins : un usage, une divulgation, un destinataire, une porte.

## Ce qu'on change

- **Contrats** : `AiDataUseSchema` gagne `decision`. `AI_DATA_DISCLOSURES.decision` : une phrase qui dit ce qui part — « Le texte des pages web que vos bots visitent, avec les noms des éléments et le contenu des champs non secrets, est envoyé pour choisir l'élément à activer et vérifier le résultat d'une action. » — sans nommer un vendeur (le nom vient du destinataire). ~~`AI_DISCLOSURE_VERSION` avance~~ *Écart : la version reste `2026-09-14` (décision du mainteneur, commit « keep the AI disclosure version unchanged »).*
- **API** : `apps/api/src/ai-consent.ts` dérive un destinataire depuis la connexion du ticket 03 (nom affichable depuis le fournisseur et l'endpoint, `privacyUrl` si le fournisseur en publie une ; aucune URL inventée pour un endpoint personnalisé, règle déjà écrite dans `docs/ai-data-sharing-review.md`). Pas de destinataire quand aucune connexion n'existe.
- ~~**La porte à l'émission**~~ (non livré) : la résolution du `DecisionProvider` pour un run (ticket 03, `resolve(spaceId)`) prend en compte l'utilisateur du run ; sans consentement à ce destinataire, elle rend `undefined` et `decideWithin` répond `unavailable(not_consented)`. Résultat : le tour d'aujourd'hui, pas d'erreur, pas de blocage. C'est différent de la porte mobile (qui bloque l'envoi d'un message) et c'est voulu : un fournisseur de décision optionnel se dégrade, il n'interrompt pas.
- **Mobile** : rien de nouveau à dessiner ; l'alerte existante liste les destinataires configurés, et le nouveau y apparaît. La copie de l'alerte est déjà générique.
- **Web et Electron** : le statut `Account → AI data sharing` liste déjà les destinataires ; vérifier qu'il n'a pas un filtre sur les trois usages actuels.
- **Docs** : `docs/ai-data-sharing-review.md` gagne le fournisseur de décision dans les portes de release (vérifier l'accord, la rétention, la suppression du fournisseur avant de le déclarer) et dans la liste de vérification manuelle.

## Fichiers

- `packages/contracts/src/ai-consent.ts` — usage, divulgation, version.
- `apps/api/src/ai-consent.ts` — dérivation du destinataire ; `router.ts:552` si la clé de destinataire est typée par usage.
- `packages/adapters/src/decision-provider-factory.ts` — résolution conditionnée au consentement de l'utilisateur du run.
- `apps/mobile/` — surface de consentement : relecture seulement, ajout de test si la liste d'usages est codée en dur.
- `apps/web/` — écran de statut : relecture.
- `docs/ai-data-sharing-review.md`, `docs/self-host.md`.

## Vérification

Offline : test API sur la dérivation (connexion présente → destinataire ; absente → aucun), ~~test de la porte~~ (non livré) (utilisateur non consentant → `unavailable(not_consented)` et `browser_act` inchangé ; consentant → provider résolu), test de contrat sur le schéma. Manuel, dans la liste de `docs/ai-data-sharing-review.md` : sur mobile, la première action après connexion du fournisseur demande la permission et la nomme ; « Pas maintenant » laisse le bot travailler sans lui.

## Ce qui reste ouvert

- Le mode « exporter sans contenu » n'a pas de sens ici : sans le `state`, il n'y a pas de décision. Donc non consenti = pas de fournisseur, point. À écrire dans la divulgation ? Non : c'est le comportement, pas une capacité ; pas de copie.
- Un espace partagé : la connexion est par espace, le consentement par utilisateur. Un bot lancé par une routine (sans utilisateur au clavier) utilise le consentement de l'utilisateur propriétaire du run, comme pour `model`. À confirmer dans `apps/api/src/ai-consent.ts` avant de coder.

**Blocked by:** 02 (03 pour un destinataire réel à dériver)

**Status:** done (lot 1, 2026-09-26, minimal)

- [x] `decision` est un usage du vocabulaire, avec sa divulgation ~~et une version de divulgation avancée~~ (version inchangée, voulu)
- [x] Un destinataire n'apparaît que si une connexion existe ; son nom vient du fournisseur de la connexion (`recipientName` dans `packages/adapters/src/ai-consent.ts` : `openrouter` → « OpenRouter »), jamais d'une constante vendeur dans `contracts`
- [ ] ~~Sans consentement : aucun octet du `state` ne quitte le processus~~ — abandonné : pas de porte serveur
- [ ] ~~Avec consentement : le fournisseur est résolu pour ce run seulement~~ — abandonné : résolu pour tout run de l'espace qui a une connexion
- [x] Le `state` passe par `redactSecrets` avant l'envoi (testé au niveau de `browserActFromTool`, `browser-targets.test.ts`)
- [x] `docs/ai-data-sharing-review.md` mis à jour ; entrée CHANGELOG du 2026-09-26

## Livré — écarts avec le texte ci-dessus

- **Contrat** `packages/contracts/src/ai-consent.ts` : `AiDataUseSchema = model | voice | memory | decision` ; divulgation réelle : « The address and title of web pages your bots use, the names of links, tabs, and text fields on them, and the bot's short description of the one it wants are sent to choose which element to act on. » Elle ne parle pas de vérifier le résultat d'une action : **le ticket 05 devra l'étendre** s'il envoie d'autres données.
- **API** `apps/api/src/ai-consent.ts` : `decision` fait partie des usages par défaut ; destinataire ajouté quand `SpaceDecisionConfig` existe (`provider`, `baseUrl`, `modelId`).
- **Porte mobile** : `aiDataUsesForProcedure` (`packages/core/src/ai-consent.ts`) déclare `decision` avec `model` et `memory` pour les procédures d'envoi ; l'alerte mobile existante liste le destinataire. Aucun écran neuf, aucune copie mobile ajoutée.
- **Pas de porte serveur** : ni `not_consented`, ni résolution conditionnée au consentement. Un espace connecté envoie les données de décision pour tous ses runs, routines comprises ; la connexion par un propriétaire d'espace tient lieu d'opt-in.
- **Docs** : `docs/ai-data-sharing-review.md` (porte de release et étape de vérification manuelle), `docs/self-host.md`.
