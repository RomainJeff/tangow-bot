# 01: Ajouter un outil `edit_file` ; trancher `grep`/`glob`

**What to build:** Un outil `edit_file` qui remplace un fragment unique d'un fichier du bot sans réécrire le fichier entier, avec un contrat d'échec explicite (fragment absent, fragment ambigu). `grep` et `glob` ne sont pas ajoutés : la section dédiée dit pourquoi et ce qui ferait changer d'avis.

## Ce que le bot a aujourd'hui

Les outils fichier de `packages/adapters/src/builtin-tools.ts` sont `list_files` (`:118`, `{path}` optionnel), `read_file` (`:127`, `{path}` seul, ni `offset` ni `limit`), `write_file` (`:137`, `{path, content}`), `attach_file` (`:150`) et `shell` (`:160`, `{command, cwd}`). Pas de `edit`, pas de `grep`, pas de `glob`.

Conséquence mesurable sur `read_file` → `write_file` : un fichier de 200 Ko se lit en entier (plafond `MAX_MODEL_FILE_BYTES = 250_000`, `executor.ts:348`, appliqué à `:2426-2428`), puis se réécrit en entier — le contenu transite deux fois par le contexte du modèle, et la réécriture intégrale est le mode de corruption classique (troncature silencieuse quand le modèle « résume » un bloc qu'il n'a pas relu).

## Contrat sandbox

Un outil d'édition n'a besoin que de deux primitives, et les deux existent sur `SandboxProvider` (`packages/adapter-kit/src/interfaces.ts:79`) :

| Primitive | Signature | Ligne |
|---|---|---|
| lecture | `readFile(computer, path, context, options?: { maxBytes?: number }): Promise<Uint8Array>` | `:137-142` |
| écriture | `writeFile(computer, file: PortableFile, context): Promise<void>` | `:143` |

Les huit fournisseurs (`box`, `daytona`, `desktop`, `docker`, `e2b`, `none`, `host-aware`, `fake`) les implémentent déjà — c'est exactement ce que `read_file` (`executor.ts:2421`) et `write_file` (`:2460`) consomment. Aucun fournisseur n'a à changer, et `sandbox-conformance.test.ts` couvre déjà les deux primitives. Coût par fournisseur : zéro.

La résolution de chemin (`resolveBotWorkspacePath(computerMode, bot.id, filePath)`, `:2423`) et la rédaction des secrets à la lecture (`redactSecrets(...)`, `:2448`) sont à réutiliser telles quelles.

## Ce que pi-agent-core fournit déjà

`@earendil-works/pi-agent-core@0.85.1` (dépendance directe de `packages/adapters`) embarque dans `dist/harness/tools/` un `createEditTool` (`edit.d.ts`) réexporté par le point d'entrée principal (`dist/index.d.ts:19`). Son moteur, `edit-diff.js`, vit dans le même dossier mais n'est réexporté nulle part (voir plus bas).

Sémantique : `{ path, edits: [{ oldText, newText }] }` — une liste de remplacements par fragment, pas un diff ni un patch. Le moteur (`edit-diff.js`) :

- normalise les fins de ligne (`normalizeToLF`, `restoreLineEndings`, `detectLineEnding`) et retire le BOM ;
- tente une correspondance exacte, puis une correspondance floue (`normalizeForFuzzyMatch` : espaces de fin, guillemets typographiques, tirets Unicode, espaces spéciales) ;
- échoue si le fragment est absent : `Could not find edits[i] in <path>. The oldText must match exactly including all whitespace and newlines.` (`:184-186`) ;
- échoue si le fragment n'est pas unique : `Found N occurrences of edits[i] in <path>. Each oldText must be unique. Please provide more context to make it unique.` (`:188-192`, comptage à `:235-237`) ;
- échoue si deux edits se chevauchent (`:251`) ;
- renvoie `{ diff, patch, firstChangedLine }` (`EditToolDetails`).

Mais `createEditTool` travaille sur un `ExecutionToolContext` dont `env: ExecutionEnv` (`tool-context.d.ts`), et `ExecutionEnv extends FileSystem, Shell` (`harness/types.d.ts:289`). `FileSystem` (`:170`) demande une quinzaine de méthodes (`absolutePath`, `joinPath`, `readTextFile`, `readTextLines`, `readBinaryFile`, `writeFile`, `appendFile`, `renameFile`, `fileInfo`, `listDir`, `canonicalPath`, `exists`, `createDir`…). Implémenter un `FileSystem` par-dessus `SandboxProvider` pour brancher l'outil tel quel est disproportionné : rakazo n'a que `readFile`/`writeFile`/`listFiles` côté sandbox. Le seul usage actuel de `ExecutionEnv` dans rakazo est local (`NodeExecutionEnv` pour l'enregistrement JSONL, `pi-session.ts:6`, `:161`).

Les fonctions pures de `edit-diff.js` (`applyEditsToNormalizedContent` et compagnie) ne sont pas réexportées par `dist/index` — seul `createEditTool` l'est. Deux chemins :

| Chemin | Coût | Risque |
|---|---|---|
| Importer `@earendil-works/pi-agent-core/dist/harness/tools/edit-diff.js` par chemin profond | ~0 code | Pas dans la carte `exports` du package (les huit entrées de `package.json` sont `.`, `./node`, `./harness/context`, `./harness/env/nodejs`, `./harness/runtime/reducer`, `./harness/session`, `./harness/session/testing`, `./package.json` — rien sous `./harness/tools`) — l'import casse à la première montée de version |
| Réécrire dans `executor.ts` un remplacement unique `oldText → newText` avec les deux erreurs qui restent applicables (absent, ambigu — le chevauchement ne peut pas se produire avec un seul remplacement par appel) et sans correspondance floue | ~40 lignes + tests | Aucun |

Recommandation : le second. La correspondance floue est un confort pour un IDE où l'humain voit le diff ; pour un bot hébergé, une erreur nette qui renvoie le modèle relire le fichier est le comportement voulu. Reprendre les messages d'erreur de pi mot pour mot : ils sont rédigés pour être lus par un modèle.

## Schéma proposé

```
edit_file { path: string, old_text: string, new_text: string }
→ { path, replaced: true, first_changed_line }
→ { error: "Could not find the exact text in <path>. …" }
→ { error: "Found N occurrences of the text in <path>. The text must be unique. …" }
→ { error: "<path> is too large to edit (N bytes, limit 250000)." }
```

Un seul remplacement par appel (pas le tableau `edits` de pi) : c'est plus court à implémenter, et le modèle enchaîne des appels si besoin. Le résultat ne renvoie pas le diff complet — 02 borne les résultats d'outils, inutile de créer une nouvelle source de gros résultats.

`edit_file` va dans `APPROVAL_EXEMPT_TOOLS` (`packages/core/src/action-approval.ts:3-23`) à côté de `write_file`, et dans `UNATTENDED_SAFE_BUILTIN_TOOLS` (`:38-53`) si `write_file` y est ; même périmètre d'effet, même politique.

## `grep` et `glob` : pas maintenant

Ces deux outils sont couverts par `shell` (`grep -rn`, `rg`, `find`, `ls`) dans la sandbox, sans plafond de sortie autre que celui de 02. Ce qu'un outil dédié apporterait : arguments typés, moins d'erreurs de quoting, un résultat structuré. Ce qu'il coûte : deux branches de plus dans `applyTool`, une dépendance à la présence de `rg` dans chaque image de sandbox (grok embarque le binaire : `shell-exec/ripgrep.ts:53` `getRipgrepBinaryPath`), et un plafond de sortie à concevoir par outil.

Rakazo n'a pas les traces pour trancher : `pi-run-trace.ts` enregistre les arguments d'outils (`:150-156`) mais l'export est optionnel et personne n'a compté la part de `shell` qui est du `grep`/`find`. Critère pour rouvrir : si, sur un échantillon de runs, plus d'un appel `shell` sur quatre est une recherche, ou si les erreurs de quoting shell sont visibles dans les traces, un `grep` dédié se justifie. `glob` seul ne se justifiera pas : `list_files` récursif ou `find` suffisent.

Côté pi, il n'y a rien à reprendre non plus : `dist/harness/tools/` contient `bash`, `edit`, `read`, `write` et rien d'autre — aucun outil `grep` ni `glob`. Le harness de référence vit lui aussi avec `bash` pour la recherche.

Côté grok, les modules `agent-exec/grep.ts`, `pi-grep.ts`, `pi-find.ts`, `pi-edit.ts` ne sont que des déclarations de ressources RPC protobuf (`createResource<Executor<PiEditExecArgs, …>>`), l'implémentation vit dans le shell Electron et n'est pas dans la reconstruction. Ils confirment le découpage « un module par outil », pas une sémantique à copier.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `edit_file` déclaré dans `builtin-tools.ts` avec `{ path, old_text, new_text }`, description qui dit « fragment unique, échec net sinon »
- [ ] Branche dans `applyTool` : lecture via `deps.sandbox.readFile` avec `MAX_MODEL_FILE_BYTES`, remplacement exact unique, écriture via `deps.sandbox.writeFile`, mêmes résolution de chemin et erreurs UTF-8 que `read_file`
- [ ] Les trois erreurs (absent, ambigu, fichier trop gros) sont renvoyées comme `{ error }` avec un texte lisible par le modèle, pas levées
- [ ] `edit_file` ajouté aux listes d'approbation avec la même politique que `write_file`
- [ ] Tests sur `fake-sandbox` : remplacement, absent, deux occurrences, fins de ligne CRLF préservées
- [ ] Le prompt système mentionne `edit_file` à côté de `write_file` dans le paragraphe outils (`executor.ts:1701-1711`) sans déplacer un fragment du préfixe cacheable
- [ ] Pas de `grep`/`glob` ; le ticket reste la référence du critère de réouverture
