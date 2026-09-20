# 19: Rejouer les tool calls de l'historique comme de vrais tool calls, pas comme du texte

**What to build:** Un bot qui relit un tour passé voit ses appels d'outils sous la forme que le modèle connaît — des blocs `toolCall` / `toolResult` dans la pile de messages — au lieu d'une ligne de prose qui les décrit.

Aujourd'hui un appel d'outil stocké est rendu en texte par `toolStepsToHistoryText` (`packages/core/src/attachments.ts`) :

```
[tool shell(git status) → On branch main…]
```

Cette chaîne est concaténée dans le `content` du tour assistant, et `toHistory` (`packages/adapters/src/pi-runtime.ts`) la rejoue comme un unique message `assistant` dont le contenu est une seule string. Le modèle reçoit donc une *description* de ce qu'il a fait, pas la structure qu'il a produite. La docstring de `toHistory` le dit déjà noir sur blanc : « Historical tool calls stay the rendered text they were stored as — their call ids are not persisted. »

Trois coûts concrets :

- le modèle doit ré-interpréter en langage naturel une structure qu'il sait lire nativement, ce qui est exactement le genre de bruit qui le pousse à relancer un outil déjà lancé ;
- les payloads sont tronqués à 160 caractères en entrée et 320 en sortie (`TOOL_TRACE_INPUT_MAX_CHARS`, `TOOL_TRACE_OUTPUT_MAX_CHARS`), donc un résultat d'outil un peu long est illisible au tour suivant ;
- rien ne distingue un vrai appel d'outil d'un message utilisateur qui contiendrait le texte `[tool …]`.

**Ce qui bloque aujourd'hui, et pourquoi ce n'est pas si cher :** le schéma `steps` dans `packages/contracts/src/events.ts` stocke `calls: { name, input, output }[]` — pas d'identifiant. Or l'id existe déjà côté écriture : `executor.ts` indexe la map `toolDetails` par `event.executionId` au moment où l'appel se résout, et s'en sert pour retrouver le détail. Il n'est simplement jamais écrit dans le bloc persisté. Ajouter un `id` optionnel à `ToolCallDetail` et le renseigner à ce point-là est un changement additif et rétro-compatible.

**Points de vigilance :**

- **Appariement.** Un `toolCall` sans `toolResult` correspondant fait rejeter la requête par la plupart des providers. Un run interrompu, annulé ou tombé en timeout peut laisser un appel sans résultat persisté : la reconstruction doit détecter la paire incomplète et retomber sur le rendu texte pour ce bloc plutôt que d'émettre un orphelin.
- **Rétrocompatibilité.** Tous les messages déjà en base n'ont pas d'id. Le rendu texte doit rester le chemin par défaut pour eux, indéfiniment — pas de migration de backfill, l'information n'existe pas.
- **Troncature.** Les caps actuels abrègent les payloads à l'écriture. Rejouer un résultat tronqué comme un `toolResult` natif le présente au modèle comme le résultat complet. Décider explicitement : soit on lève le cap pour les appels qui seront rejoués nativement, soit on marque la troncature dans le contenu du résultat.
- **Dépendance SDK.** Vérifier d'abord que `AgentMessage` de pi-ai accepte des parts `toolCall`/`toolResult` dans un historique rejoué, et comment il veut les usages associés — le travail de réhydratation native des tours assistant (déjà dans cette PR) a établi le précédent, mais pour du texte uniquement.
- **Interaction avec le ticket 13.** Les blocs `steps` sont aussi la source du rendu UI « Display agent steps ». Le champ ajouté ne doit rien changer à ce rendu.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `ToolCallDetail` porte un `id` optionnel, renseigné depuis `event.executionId` au moment où l'appel se résout
- [ ] Le schéma `steps` de `packages/contracts` accepte ce champ sans casser la validation des messages existants
- [ ] Un tour assistant dont les appels ont un id est rejoué avec des parts `toolCall`/`toolResult` natives, pas avec la ligne `[tool …]`
- [ ] Un tour assistant dont les appels n'ont pas d'id (message ancien) est rejoué exactement comme aujourd'hui
- [ ] Un appel sans résultat persisté retombe sur le rendu texte pour ce bloc et n'émet jamais de `toolCall` orphelin
- [ ] La politique de troncature pour les résultats rejoués nativement est tranchée et documentée dans le code
- [ ] Le rendu UI des step chips est inchangé
