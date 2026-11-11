# Partager un lien vers un bot depuis le menu de partage (iOS + Android)

## Pourquoi

Aujourd'hui, pour envoyer un article à un bot, il faut copier le lien, ouvrir Tangow, choisir le bot et coller. Le menu de partage du système doit permettre de l'envoyer en deux taps, sans quitter l'app où on lit, comme avec WhatsApp.

## Ce qui est décidé

- Flow C : un écran de composition, « À » préremplie, un champ message facultatif et le lien. Une liste avec recherche ne s'ouvre que si on touche « À ».
- Cibles : les bots et les groupes de l'espace sélectionné dans l'app.
- Contenu : uniquement des liens pour l'instant (`public.url` / `text/plain` contenant une URL).
- iOS et Android dans la même foulée.

## Ce qui existe déjà et qu'on réutilise

| Besoin | Existant |
| --- | --- |
| Envoyer | `threads/send` `{ botId \| groupId, clientNonce, text }`. Le serveur ajoute l'aperçu du lien tout seul (`apps/mobile/app/thread.tsx:1508`). Aucun changement serveur pour les lots 1 et 2. |
| Lister les cibles | `spaces/list` : bots et groupes actifs de chaque espace (avec `color`, `shapeSeed`, `updatedAt`). |
| Session | Items SecureStore : `tangow.session_token`, `tangow.api_base`, `tangow.space_id`, `tangow.cf_access`. |
| Targets natives | `@bacons/apple-targets` (déjà utilisé pour la notification service). |

## Architecture

### iOS : extension de partage native en SwiftUI

Une target `share` via `@bacons/apple-targets`, en SwiftUI. Elle contient C·1 (composition) et C·2 (liste `.searchable`, poussée dans une `NavigationStack`).

Pourquoi native : une extension de partage a une limite mémoire stricte, et y embarquer Hermes avec l'app JS la fait tuer. La surface Swift reste petite : 3 RPC et l'en-tête d'authentification. Ouvrir l'app depuis l'extension ferait quitter Safari et reposerait sur une astuce non officielle.

**Session partagée, sans migration.** On ajoute l'entitlement `keychain-access-groups` = `$(AppIdentifierPrefix)com.romainjeff.tangow` à l'app et à l'extension. expo-secure-store 57 écrit sans groupe explicite, donc dans le groupe par défaut, qui est exactement cette chaîne : les items existants y sont déjà. `ShareClient.swift` reproduit la requête de SecureStore :
- `kSecAttrService` vaut `app:no-auth`, puis `app` pour les anciens items ;
- `kSecAttrAccount` est la clé en `Data` UTF-8 ;
- le groupe d'accès est passé explicitement.

À prouver d'abord sur un build de développement installé sur un appareil.

**Valeurs de build.** `expo-target.config.js` écrit `EXPO_PUBLIC_API_URL` et le jeton Access par défaut dans l'`Info.plist` de l'extension. Ils sont déjà dans le bundle JS, donc l'exposition ne change pas. On porte à l'identique deux règles :
- la normalisation de `normalizeApiBase` ;
- la règle de `accessFor` (`lib/access-store.ts:13`) : le jeton stocké seulement si son origine correspond, le jeton de build seulement si la base est celle par défaut.

**Client Swift minimal** (`ShareClient.swift`) :
- `POST {base}/rpc/{proc}` avec le corps `{ json: input }` et les en-têtes `authorization: Bearer`, `x-tangow-space-id`, `origin: tangow://` et Access ;
- `spaces/list` : les bots et groupes actifs de tous les espaces, triés par `updatedAt`, avec le nom de l'espace quand il y en a plusieurs ; l'envoi passe l'espace de la cible dans `x-tangow-space-id` ;
- `threads/send` avec `text = note.isEmpty ? url : "\(note)\n\n\(url)"`.

**« À » par défaut.** L'extension garde sa propre dernière cible de partage `{ kind, id }` (UserDefaults de l'extension). Si cette cible est dans la liste, on la prend. Sinon, notamment au tout premier partage, « À » reste vide : Envoyer est désactivé tant qu'on n'a pas choisi. `last-bot.ts` reste tel quel.

**Avatars.** Un disque à la couleur du bot à côté du nom ; pour un groupe, un symbole SF neutre. Le bloub natif demanderait de porter en Swift le hash de forme, le style robot et l'avatar composite de groupe : ce n'est pas justifié pour une feuille qu'on voit deux secondes.

**États** :
- pas de session → « Sign in to Tangow to share » et Annuler ;
- échec d'envoi → la feuille reste ouverte avec la raison du serveur ; Envoyer reste disponible ;
- succès → haptique, la feuille se ferme. La réponse du bot arrive en notification (déjà en place).

**Copy** (en, ru, zh dans un String Catalog de l'extension) : Cancel, Send, To, Add a message, Search, Sign in to Tangow to share. Une seule liste triée par activité, sans titres de section.

**À ne pas faire dans ce lot :** déclarer `IntentsSupported`. iOS se mettrait à afficher des suggestions à partir des donations de notifications existantes. Une notif de groupe y figure avec le bot comme expéditeur : on préremplirait le bot au lieu du groupe.

### Android : le menu de partage ouvre l'écran de composition dans l'app

Sur Android, le modèle natif est que l'app s'ouvre (WhatsApp fait pareil).

- `app.json` → `android.intentFilters` : `SEND`, `DEFAULT`, `text/plain`.
- Un module Expo local Android (`modules/tangow-share`) expose `EXTRA_TEXT` / `EXTRA_SUBJECT` au lancement et sur `onNewIntent`. Expo Linking ne voit pas ces extras.
- Une route Expo Router `/share` (feuille modale) reprend C·1 / C·2 avec les primitives existantes : `BotAvatar`, `GroupAvatar`, le kit `Group` / `Row`, les tokens via `lib/appearance`, et `rpc()`, donc espace et en-têtes gratuits.
- La logique pure va dans `lib/share.ts`, testée : extraire l'URL, composer le corps, choisir la cible par défaut. Même règle qu'iOS : la dernière cible de partage (stockée par l'écran `/share`) si elle est dans la liste, sinon « À » vide.
- Après l'envoi : retour à l'app d'origine (`moveTaskToBack` exposé par `tangow-share`).

## Découpage (PR indépendantes vers `main`)

1. **iOS — extension de partage.** Entitlement du trousseau, target `share`, `ShareClient.swift`, C·1 / C·2.
   - Étape 1, avant le reste : un build de développement sur l'appareil qui prouve la lecture de la session sans reconnexion.
   - Entrée CHANGELOG.
2. **Android — cible de partage.** Filtre d'intent, module `tangow-share`, route `/share`, `lib/share.ts`.
   - Entrée CHANGELOG (ou une seule entrée commune si 1 et 2 sortent le même jour).
3. **Après les lots 1–2 : partage direct** (la rangée ① de la maquette). Elle montre les bots et groupes avec qui on a échangé récemment. Il faut :
   - côté serveur, ajouter `groupName` + `spaceId` au payload push ;
   - `speakableGroupName` dans `NotificationService` (messages reçus) ;
   - une donation sortante à chaque message envoyé dans l'app et à chaque partage (messages envoyés), via un petit module natif iOS ;
   - `IntentsSupported` + préremplissage depuis `extensionContext.intent` ;
   - côté Android, des sharing shortcuts publiés pour les mêmes conversations récentes.

## Tests

- `lib/share.ts` : texte avec titre + URL, URL seule, pas d'URL ; corps envoyé ; cible par défaut absente, archivée ou supprimée → « À » vide.
- Test de contrat TS, dans le style string-match de `android-platform-contract.test.ts` : `ShareClient.swift` contient bien les clés `tangow.session_token`, `tangow.api_base`, `tangow.space_id`, `tangow.cf_access`, le service `app:no-auth` et les champs JSON Access. Une clé renommée échouerait en silence (« Sign in… ») ; un nom de procédure faux échoue bruyamment dès le premier partage, donc on ne le teste pas.
- Captures : iOS à la main sur l'appareil (l'extension ne se pilote pas) ; Android via `adb shell am start -a android.intent.action.SEND …`. Les deux sont signalées dans les PR.

## Livraison

Nouvelle target iOS et nouveaux filtres Android : il faut un build natif, pas une mise à jour OTA. On passe par le skill `release`. EAS synchronise l'entitlement du trousseau sur les profils de provisioning.

## Revue founding-engineer et décisions

| # | Recommandation | Décision |
| --- | --- | --- |
| 1 | Reporter le partage direct ; pas d'`IntentsSupported` dans le lot 1 | **Acceptée en partie** : sorti des lots 1–2 et devenu le lot 3 optionnel. Ta demande initiale parlait de « directement un bot comme WhatsApp », donc c'est à toi de dire si on le garde. La correction « il faut un changement serveur » est intégrée. |
| 2 | Pas de bloub en Swift : disque de couleur + symbole pour les groupes | Acceptée. |
| 3 | Ne pas généraliser `last-bot.ts` ; l'extension garde sa dernière cible ; espace sélectionné seulement | Acceptée. |
| 4 | Consentement par cible, juste avant l'envoi, en bloquant sur toute erreur | Sans objet : le flow de consentement IA a été retiré de main (#460). |
| 5 | Reproduire exactement la requête trousseau de SecureStore | Acceptée. |
| 6 | Porter la règle `accessFor` + normalisation de la base | Acceptée. |
| 7 | Test de contrat limité aux clés du trousseau | Acceptée. |
| 8 | Pas de flow Maestro Android ; capture via `adb` | Acceptée. |

## Décisions du mainteneur (2026-11-01)

1. Partage direct : fait en lot 3, après les lots 1–2, à partir des conversations récentes.
2. « À » par défaut : la dernière cible de partage ; vide au premier partage.
3. Android après l'envoi : retour à l'app d'origine.
