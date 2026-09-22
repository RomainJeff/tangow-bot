# Non-objectifs — Jev pour la partie navigateur

Écarté volontairement. Chaque entrée vient soit d'une recette publiée par un harnais Jev de la communauté, soit d'une extension tentante de la même idée. Documenté pour que personne ne les réintroduise par réflexe.

## Jev sur le bureau en pixels (`computer_observe` / `computer_act`)
Jev est texte uniquement : images, audio et vidéo doivent être convertis en texte ou en champs structurés avant d'entrer dans le `state` (confirmé par plusieurs sources secondaires, puis par la documentation officielle `docs.typesafe.ai` — voir ticket 01, « Faits résolus »). `computer_observe` rend un PNG. Faire décider Jev sur le bureau supposerait une couche OCR ou de détection de régions, c'est-à-dire une nouvelle surface de panne entre l'écran et la décision, avec ses propres erreurs de lecture, et des coordonnées que Jev devrait choisir dans une grille inventée par nous. La page web a déjà sa table de candidats ; le bureau n'en a pas. Hors lot tant que le navigateur n'a pas prouvé sa valeur.

## Adopter `browser-use`, `jev-ultrafast`, `fastbrowse`, `jev-for-chrome`, `jev-browser` ou `jevkit` comme dépendance
Tranché au ticket 01. Résumé : quatre sur six sont en Python (notre pile est TypeScript/pnpm), `jev-for-chrome` est une extension MV3 dans le Chrome de l'utilisateur, `jev-browser` est en TypeScript mais embarque Playwright et son propre Chromium ; tous possèdent leur propre boucle observer-décider-agir alors que le backend doit posséder orchestration, approbation, baux d'écran, garde anti-boucle d'outils et checkpoints. Aucun ne pilote un Chrome distant par CDP dans un conteneur avec des profils persistants par bot. Ils restent des références de conception, lues et citées dans les tickets, pas des dépendances.

## Laisser Jev écrire les valeurs de champs
Jev ne génère pas de texte. Tous les harnais étudiés délèguent la valeur d'un `fill` à un petit modèle de langage séparé. Nous avons déjà ce modèle : c'est le modèle principal du run, qui fournit `text` dans `browser_act` aujourd'hui. Ajouter un second modèle de texte « rapide » pour les valeurs recréerait la sélection de modèle d'aide et ses réglages pour un gain non démontré. Les mots de passe ne passent de toute façon jamais par un modèle : ils viennent des secrets stockés (`request_secret`, `secret_request`).

## Une boucle autonome `browser_run(goal)` pilotée par Jev
Recette de `jev-ultrafast`, `jev-for-chrome` et `jev-browser` : Jev choisit opération et cible à chaque pas, juge « but atteint » et « bloqué », et le modèle de langage n'intervient qu'au début et pour les textes. C'est une seconde boucle d'agent, qui devrait ré-implémenter approbations, baux, garde anti-boucle, checkpoint et prise de contrôle — tout ce que `executor.ts` fait déjà pour un pas. Les tickets 04 et 05 obtiennent la moitié du gain (le modèle ne lit plus la page pour cliquer) sans nouvelle boucle. Si 08 montre que le tour de modèle restant domine encore le coût, un ticket suivant pourra rouvrir la question avec des chiffres.

## Rejouer automatiquement une action jugée `unchanged` ou `error`
Le contrat `docs/computer-runtime.md` interdit le rejeu automatique d'une action terminée ou incertaine, parce que l'effet peut avoir eu lieu sans que la réponse revienne. La vérification du ticket 05 est consultative : elle annote, elle ne relance pas. Un `unchanged` signifie « inspecte », pas « recommence ».

## Retargeting d'un `ref` périmé par Jev
Le helper rejette un ref périmé au lieu de viser l'élément de remplacement, et c'est voulu : un remplacement peut être un autre bouton au même endroit. Faire choisir par Jev « l'élément le plus proche » du ref périmé rétablirait le retargeting par une autre porte. Un ref périmé reste une erreur rendue au modèle, avec un snapshot frais.

## Gate d'approbation par Jev (`classify` consequential / payment / delete)
Tentant : un `noul` « ce bouton déclenche-t-il un paiement ou une suppression ? » avant un clic pourrait alimenter `planActionGate` (`packages/core/src/action-approval.ts`). Mais le gate existant repose sur des règles utilisateur, des heuristiques de noms d'outils et un juge modèle avec timeout ; y ajouter un troisième avis demande de définir ce qui l'emporte, et une erreur de Jev dans ce rôle laisse passer un achat. Hors lot ; à rouvrir seulement si 06 montre une calibration solide sur la classe `auth`/`dialog`, qui est la plus proche.

## Une variable d'environnement `TYPESAFE_API_KEY`
Le SDK la lit par défaut et lève `missingApiKey` sans elle. Nous ne l'utilisons pas : la clé, l'URL de base et l'identifiant de modèle passent par les réglages de connexion partagés et sont traduits en `TypeSafeClientConfig` dans l'adaptateur seulement (ticket 03), conformément à `AGENTS.md`. Le client n'est jamais instancié quand rien n'est configuré.

## Un fournisseur de décision par modèle de langage « JSON schema » dans ce lot
`jevbench` montre que d'autres systèmes répondent au même contrat via un endpoint OpenAI-compatible avec schéma. L'interface du ticket 02 est volontairement neutre pour le permettre plus tard, mais écrire cet adaptateur maintenant, sans avoir mesuré Jev, serait une abstraction spéculative. Le fake en process suffit à garantir que le cœur tourne sans vendeur.

## Playwright, Puppeteer ou une extension MV3 dans le conteneur
Notre Chrome tourne dans le sandbox, sur l'écran visible du bot, avec un profil persistant par identité, piloté par CDP sur la boucle locale via un helper sans dépendance (`rakazo-page-browser`). Ajouter Playwright côté hôte ou une extension dans chaque profil changerait la frontière de sécurité et le cycle de vie des profils pour reproduire ce que le helper fait déjà.
