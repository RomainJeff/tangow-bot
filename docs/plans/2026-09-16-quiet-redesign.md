# Quiet — refonte UI vague 1 (peau + design system) — Implementation Plan

> **For Claude:** ce document est le contrat de design de la vague 1. Chaque PR est exécutée par un sous-agent qui ne lit que `AGENTS.md`, ce fichier et son périmètre. Ne pas réinterpréter les valeurs : elles viennent de la maquette validée. Toute question d'écart au design remonte au mainteneur, elle ne se tranche pas dans la PR.

**Goal :** Rakazo adopte la direction « Quiet » : deux volets (sidebar 280 px + fil), zéro cadre sur les messages, une seule couleur par bot et elle ne vit que dans l'avatar, encre partout ailleurs, une seule élévation par écran. La vague 1 livre cette peau sur web, desktop (Electron sert le build web) et mobile, **via un design system** : 7 familles de tokens dans `@rakazo/ui-tokens` et des primitives nommées dans `@rakazo/ui-web` (équivalents natifs dans `apps/mobile/components`). Aucune mécanique produit nouvelle.

**Architecture :**
1. Un contrat écrit (ce fichier) avant la première ligne de code ; `docs/design-system.md` devient la référence vivante à partir de la PR 3.
2. Extraire d'abord, restyler ensuite : `apps/web/src/pages/Shell.tsx` (6 100 lignes) est découpé mécaniquement en `pages/shell/*` (PR 0) sans changement visuel.
3. Les tokens d'abord (PR 1) : les classes Tailwind existantes se résolvent vers les nouvelles valeurs, l'app change de peau d'un coup, les PR suivantes ne font que de la structure locale.
4. Un écran ne définit jamais une couleur, une taille, un rayon, une ombre ou une durée en dur : il compose des tokens et des primitives.

**Tech Stack :** pnpm monorepo, TypeScript, React 19, Vite 8, Tailwind v4 CSS-first (`@theme inline` dans `packages/ui-web/src/styles.css`, pas de `tailwind.config`), shadcn style `base-nova` sur `@base-ui/react`, lingui (`t`/`Trans` de `@lingui/react/macro`), vitest en environnement node (assertions `renderToString`), Playwright (65 specs dans `apps/web/e2e`, captures documentaires via `captureScreenshot(page, testInfo, name)` de `apps/web/e2e/helpers.ts`, pas de diff pixel), Expo Router + StyleSheet côté mobile.

**Conventions repo :**
- Typecheck `pnpm check`, lint `pnpm lint` (biome), tests `pnpm test`, e2e ciblé `pnpm --filter @rakazo/web e2e <spec>`, e2e complet en CI uniquement. Jamais le e2e desktop Playwright en local.
- `pnpm --filter @rakazo/ui-tokens generate` après toute modification de `packages/ui-tokens/src/index.ts` (sinon `appearance.test.ts` échoue).
- Copie visible : `t`/`Trans`, puis `pnpm --filter @rakazo/web intl:extract` ; la PR cite chaque nouvelle chaîne et dit pourquoi elle est nécessaire (`AGENTS.md`).
- `CHANGELOG.md` : une entrée sous `## [Unreleased]` / `### <jour>` par changement observable, écrite pour l'utilisateur ; rien pour les PR invisibles (0, 3, 14).
- Remotes : `origin` = fork (branche d'intégration `quiet`, PR par `feat/quiet-<n>`), `upstream` = dépôt du mainteneur amont (PR 0 y est proposée telle quelle ; PR 1, 2, 3 ensuite). Ne jamais tirer depuis le troisième remote.
- Commits : message clair, trailer `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Repo public : aucun nom de personne, chemin local, hostname ou identifiant de compte dans le code, les fixtures, les commits ou les PR.
- Propriétés logiques uniquement (`ps-*`, `pe-*`, `start-*`, `end-*`, `border-s`, `rounded-s-*`) : le repo gère le RTL.

**Decisions already made (ne pas rouvrir) :**
- Vague 1 = peau seulement. Hors scope : read receipts, réactions « confirmed », draft partagé, Saved / épingles, « Plus tard » sur une décision, ligne de provenance générique, aperçu de lien, section « Saved » de la sidebar, états émotionnels de l'avatar, écran d'appel mobile (il n'en existe pas aujourd'hui).
- Le panneau droit (computer, routines, settings, create, group-settings, routine) garde sa machine `Panel` et son contenu ; il devient une superposition non modale du fil, ouverte par un bouton « Computer & routines » dans le header du fil. Pas de clic-extérieur pour fermer.
- Avatar : `organic` devient le défaut (web, mobile, colonne Prisma) ; `robot` reste en opt-in dans Réglages › Apparence ; l'anneau de statut disparaît (working = corps animé + lueur). Le `BotAvatar` de la maquette est déjà le code de `OrganicAvatar` (`packages/ui-web/src/bot-avatar.tsx`) et de `packages/core/src/avatar-shape.ts` : ne pas le réécrire.
- Déploiement à trois jalons (après PR 0–3, après PR 4–10 + rebuild desktop, après PR 11–13), jamais PR par PR.
- Aucun snapshot pixel : les captures Playwright restent documentaires.

---

## 1. Tokens — 7 familles, une source : `packages/ui-tokens/src/index.ts`

Le générateur (`src/generate-css.ts` → `src/tokens.css`) émet chaque famille en variables CSS sous `:root, [data-theme="dark"]` et `[data-theme="light"]` ; `packages/ui-web/src/styles.css` les mappe dans `@theme inline` (motif existant : `--color-x: var(--x)`) ; mobile lit les mêmes objets TS (`tokensForAppearance()`, `typography`, `space`, `radii`, `sizes`, `motion`) et garde ses ombres natives.

### 1.1 Couleur (`ColorTokens`, light / dark)

**Règle : tous les slots de couleur sont opaques.** La maquette exprime les gris comme des voiles d'encre ou de blanc (`rgba(17,17,20,.06)`…) ; on les **aplatit sur `background`** (le pourcentage est rappelé entre parenthèses) parce que des dizaines de consommateurs existants les traitent comme des couleurs pleines : modificateurs d'opacité Tailwind (`bg-input/30`), `color-mix`, fonds natifs empilés, teinte d'`ActivityIndicator`. Un `rgba` dans un slot est un bug.

Slots remappés :

| Slot | Light | Dark | Rôle Quiet |
|---|---|---|---|
| `background` | `#FBFBF9` | `#0C0C0E` | page |
| `foreground` | `#111114` | `#F2F2F0` | encre : texte, primaire |
| `card`, `popover` | `#FFFFFF` | `#161618` | cartes, popovers |
| `cardForeground`, `popoverForeground` | `#111114` | `#F2F2F0` | |
| `primary` | `#111114` | `#F2F2F0` | capsule primaire, bouton Send |
| `primaryForeground` | `#FBFBF9` | `#0C0C0E` | |
| `secondary` | `#EDEDEB` (encre 6 %) | `#1F1F21` (blanc 8 %) | capsule secondaire, fond Stop |
| `secondaryForeground` | `#111114` | `#F2F2F0` | |
| `chatUser` | `#F1F1EE` | `#222226` | bulle utilisateur, chip de mention |
| `chatUserForeground` | `#111114` | `#F2F2F0` | |
| `muted` | `#EDEDEB` (6 %) | `#1F1F21` (8 %) | piste du segmenté |
| `mutedForeground` | `#6E6E73` | `#9A9AA1` | gris **cliquable** : méta, heures, libellés de section, icônes |
| `accent` | `#EFEFEE` (5 %) | `#1B1B1C` (6 %) | survol des boutons icône |
| `accentForeground` | `#111114` | `#F2F2F0` | |
| `border`, `sidebarBorder` | `#E8E8E7` (8 %) | `#1F1F21` (8 %) | filet des cartes et blocs |
| `input` | `#DFDFDE` (12 %) | `#29292B` (12 %) | bord des champs, plus fort que `border` |
| `ring` | `#6E6E73` | `#9A9AA1` | focus |
| `sidebar` | `#F4F4F3` (2,8 %) | `#131315` (3 %) | fond du volet gauche |
| `sidebarForeground` | `#111114` | `#F2F2F0` | |
| `sidebarAccent` | `#FFFFFF` | `#1D1D1F` (7 %) | ligne sélectionnée et survolée |
| `sidebarAccentForeground` | `#111114` | `#F2F2F0` | |
| `link` | `#2563EB` | `#86B7FF` | inchangé |
| `destructive`, `destructiveForeground`, `success`, `warning`, `overlay`, `scrollbar`, `scrollbarHover` | inchangés | inchangés | statuts, chrome |

Slots ajoutés :

| Slot | Light | Dark | Rôle |
|---|---|---|---|
| `foregroundSubtle` | `#86868B` | `#6E6E73` | gris **passif** : deuxième ligne de la sidebar, placeholders. Jamais seul pour une information nécessaire (≈ 3,3:1) |
| `outline` | `#DADAD9` (14 %) | `#333335` (16 %) | bord des réponses rapides |
| `surface` | `#FFFFFF` | `#161618` | la seule élévation : composer, blocs cadrés, cartes, pill de survol |

Contrainte : `appearance.test.ts` exige que chaque slot diffère entre light et dark (sauf `destructiveForeground`). `botColors` reste inchangé (les couleurs des bots sont des données utilisateur).

### 1.2 Typographie (`typography`)

| Clé | Taille | Interligne | Tracking | Poids | Usage |
|---|---|---|---|---|---|
| `body` | 16.5 | 1.58 | -0.008em | 400 | prose des messages (mobile : 16 / 1.5) |
| `author` | 13 | 1.3 | -0.004em | 500 | nom du bot au-dessus d'un message |
| `time` | 12 | 1.3 | 0 | 400 | heure à côté du nom |
| `meta` | 13 | 1.4 | 0 | 400 | ligne de preuve / destination sous un message, en `mutedForeground` |
| `label` | 12.5 | 1.3 | 0 | 400 | libellés de section de la sidebar, « Today », « Seen » |
| `rowName` | 14.5 | 1.3 | -0.005em | 400 / 500 sélectionné | nom dans la sidebar |
| `rowStatus` | 12.5 | 1.3 | 0 | 400 | ligne d'état dans la sidebar, en `foregroundSubtle` |
| `title` | 19 | 1.2 | -0.014em | 500 | titre du fil (mobile : 17 / 600) |
| `capsule` | 14 | 1 | 0 | 500 primaire, 400 autres | libellé des capsules |
| `working` | 15 | 1.3 | -0.006em | 400 | « <Bot> is drafting the recap » |
| `reasoning` | 13.5 | 1.45 | 0 | 400 | « Thought for … », étapes |
| `blockHeader` | 12.5 | 1.3 | 0.01em | 500 | en-tête d'un bloc cadré (« <Bot> needs your call ») |
| `question` | 16 | 1.45 | -0.008em | 400 | question d'un bloc cadré |
| `mono` | 12.5 | 1.3 | 0 | 400 | durées, chiffres (`font-mono`, `tabular-nums`) |

Émission : `--type-<clé>-size`, `--type-<clé>-leading`, `--type-<clé>-tracking`, `--type-<clé>-weight` ; mapping Tailwind `--text-<clé>`, `--text-<clé>--line-height`, `--text-<clé>--letter-spacing`, `--text-<clé>--font-weight` → utilitaires `text-body`, `text-meta`, `text-title`, etc. Fonts : `--font-sans: "Geist Variable", ui-sans-serif, system-ui, sans-serif` ; `--font-mono: "Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, monospace` (paquet `@fontsource-variable/geist-mono`, offline). Mobile : `Platform.select({ ios: "Menlo", android: "monospace" })` + `fontVariant: ["tabular-nums"]` pour `mono`.

### 1.3 Espace (`space`)

Échelle des gaps de la maquette : `2, 3, 4, 6, 8, 10, 12, 14, 16, 22, 28`. Layout : `sidebar 280`, `thread 800` (largeur max de la colonne du fil, gouttières 14 ; la maquette montrait 668 à 1 280 px, élargi après essai sur un écran de 2 000 px), `header 56`, `panel 384`. Les paddings internes (composer 7 / 16) appartiennent aux primitives. Mapping Tailwind : `--spacing-sidebar`, `--spacing-thread`, `--spacing-header`, `--spacing-panel` → `w-sidebar`, `max-w-thread`, `h-header`, `w-panel`. Les gaps utilisent l'échelle Tailwind native, qui accepte tout multiple de 0,25 rem : `gap-3.5` = 14, `gap-5.5` = 22, `gap-7` = 28. Aucune valeur arbitraire `gap-[…]`.

### 1.4 Rayons (`radii`)

| Clé | px | Usage |
|---|---|---|
| `chip` | 6 | étiquettes de section (« 5a »), surlignage dans un draft |
| `row` | 11 | lignes de la sidebar, boutons de la sidebar |
| `card` | 14 | cartes non cadrées (routine, artefact, tableau, aperçu, bloc à copier), panneau |
| `draft` | 16 | draft partagé (vague 2) |
| `block` | 18 | blocs cadrés (décision, question), écrans de la maquette |
| `bubble` | 19 | bulle utilisateur |
| `pill` | 9999 | capsules, boutons ronds, composer, pill de survol, avatars |

Émission `--corner-<clé>` ; mapping `--radius-chip: var(--corner-chip)`… → `rounded-chip`, `rounded-row`, `rounded-card`, `rounded-block`, `rounded-bubble` ; `rounded-full` pour `pill`. `RADIUS` (0.75rem, utilisé par shadcn via `--radius`) reste pour les composants vendorés non touchés.

### 1.5 Élévation (`shadowTokens`, light / dark)

| Clé | Light | Dark | Usage |
|---|---|---|---|
| `row` | `0 1px 2px rgba(17,17,20,0.06)` | `none` | ligne sélectionnée de la sidebar |
| `card` | `0 0 0 1px rgba(17,17,20,0.08), 0 12px 30px -16px rgba(17,17,20,0.4)` | `0 0 0 1px rgba(255,255,255,0.08), 0 12px 30px -16px rgba(0,0,0,0.8)` | blocs cadrés, panneau en superposition |
| `composer` | `0 1px 2px rgba(17,17,20,0.06), 0 12px 28px -18px rgba(17,17,20,0.5)` | `0 0 0 1px rgba(255,255,255,0.08), 0 12px 28px -18px rgba(0,0,0,0.8)` | capsule du composer |
| `floating` | `0 1px 2px rgba(17,17,20,0.08), 0 8px 20px -10px rgba(17,17,20,0.35)` | `0 0 0 1px rgba(255,255,255,0.08), 0 8px 20px -10px rgba(0,0,0,0.7)` | pill de survol |

Émission `--elevation-<clé>` ; mapping `--shadow-<clé>: var(--elevation-<clé>)` (les variables générées ne portent jamais le nom d'un namespace de thème Tailwind : `--elevation-*`, `--corner-*`, `--space-*`, `--type-*`, `--size-*`, `--motion-ease`) → `shadow-row`, `shadow-card`, `shadow-composer`, `shadow-floating`. Les cartes non cadrées n'ont **pas** d'ombre : `bg-surface` + `border` seulement. Mobile : `elevation = { row, card, composer, floating }` dans `apps/mobile/lib/theme.ts` (`shadowColor`, `shadowOpacity`, `shadowRadius`, `shadowOffset`, `elevation` Android).

### 1.6 Motion (`motion`)

| Clé | Valeur | Usage |
|---|---|---|
| `ease` | `cubic-bezier(0.32, 0.72, 0, 1)` | toute transition |
| `arrive` | 240 ms, `translateY(6px)` → 0, opacité 0 → 1 | arrivée d'un message, d'un bloc, d'une capsule (décalage 60 ms entre capsules d'une même ligne) |
| `press` | 160 ms, `scale(0.94)` boutons ronds / `scale(0.96)` capsules | pression |
| `hover` | 160 ms, couleur et fond | survol |
| `breathe` | 5.6 s | respiration de l'avatar idle (déjà dans `bot-avatar`) |
| `caret` | 1 s step-end | curseur de saisie |

Émission `--motion-ease`, `--duration-arrive`, `--duration-press`, `--duration-hover` ; mapping `--ease-quiet: var(--motion-ease)` ; keyframes `rk-arrive` dans `packages/ui-web/src/styles.css` ; utilitaires `animate-arrive`, classe `rk-press`. **Rien ne boucle en continu sauf l'avatar du bot qui travaille** (et la respiration idle). `@media (prefers-reduced-motion: reduce)` : tout s'arrête sauf le clignement des yeux ; la lueur working reste statique.

### 1.7 Tailles (`sizes`)

Avatars : `receipt 14`, `stackXs 16`, `interstitial 17`, `chip 18`, `stack 20`, `message 26`, `row 28`, `call 120`. Contrôles : `hoverIcon 28`, `quickReply 32`, `composerIcon 34`, `capsule 36`, `mobileStack 44`, `callButton 52`. Émission `--size-*` ; consommation par les props `size` des primitives, pas par des classes ad hoc.

---

## 2. Primitives — `packages/ui-web/src/*.tsx`, exportées par `packages/ui-web/src/index.ts`

Chaque primitive : un fichier kebab-case à côté de `bot-avatar.tsx`, un test `*.test.tsx` en `renderToString` (structure, classes de tokens, attributs a11y), `data-slot="<nom>"` sur la racine, aucune valeur en dur, aucune logique métier (pas de RPC, pas de contexte applicatif), copie fournie par l'appelant (les primitives ne contiennent pas de `t`).

| Primitive | Props | Anatomie | États |
|---|---|---|---|
| `Button` (variants ajoutés à `button.tsx`) | `variant: capsule \| capsuleSecondary \| tertiary \| quickReply \| roundIcon`, `size: capsule (36) \| quickReply (32) \| roundIcon (34) \| roundIconSm (28) \| stack (44) \| call (52)`, `consequential?: boolean` | `capsule` : `bg-primary text-primary-foreground rounded-full px-[15px] text-capsule font-medium` ; `capsuleSecondary` : `bg-secondary text-foreground` ; `tertiary` : `bg-transparent text-muted-foreground hover:text-foreground px-3` ; `quickReply` : `border border-outline bg-transparent text-foreground hover:bg-accent hover:border-ring/40` ; `roundIcon` : `rounded-full bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground` ; `consequential` préfixe une icône cadenas 13 px | hover `opacity-85` (capsule), press `rk-press`, focus `ring` |
| `Segmented` | `options: {id,label}[]`, `value`, `onChange`, `size?: 36` | piste `bg-muted rounded-full p-[3px] h-9`, option 30 px, sélectionnée `bg-surface shadow-row font-medium`, autres `text-muted-foreground` | créée seulement si un écran de la vague 1 l'utilise ; sinon vague 2 |
| `FramedBlock` | `header: {who: string, dot?: boolean}`, `question`, `consequence?`, `actions`, `children?`, `maxWidth?` | `bg-surface rounded-block shadow-card overflow-hidden` ; en-tête `pt-[13px] px-4` : point 6 px `bg-foreground` + `text-blockHeader text-muted-foreground` ; question `text-question text-foreground pt-2 px-4` ; conséquence `text-meta text-muted-foreground pt-1.5 px-4` ; actions `flex flex-wrap gap-2 p-4 pt-3.5` (mobile : `flex-col`, capsules `stack`) | `answered` : actions remplacées par une ligne `text-meta` |
| `Surface` | `radius?: card \| block`, `as?` | `bg-surface border border-border rounded-card` (pas d'ombre) | — |
| `MessageRow` | `avatar: ReactNode`, `author`, `time`, `children`, `meta?: {label, onClick}`, `trailing?` | `flex gap-3.5` (mobile 11) ; colonne avatar `size.message` ; en-tête `flex items-baseline gap-[7px] mb-[3px]` : `text-author text-foreground` + `text-time text-muted-foreground` ; corps `text-body text-foreground [text-wrap:pretty]` **sans fond ni bordure** ; `meta` = bouton `text-meta text-muted-foreground hover:text-foreground mt-[7px]` suffixé « › » | `arrive` à l'insertion |
| `UserBubble` | `children` | `self-end max-w-[78%] rounded-bubble bg-chat-user text-chat-user-foreground px-[17px] py-[11px] text-body whitespace-pre-wrap` | — |
| `Interstitial` | `avatars: ReactNode[]` (1 ou 2), `children`, `onClick?` | `self-center flex items-center gap-[9px] px-1 py-0.5` ; avatars `size.interstitial` chevauchés `-ms-1` ; texte `text-meta text-muted-foreground` suffixé « › » ; `hover:opacity-60` | — |
| `StackedAvatars` | `items: {color, identity, working?}[]`, `size: 14 \| 16 \| 17 \| 20`, `max?: 3` | `BotAvatar` chevauchés (`-ms-[5px]` à 20, `-ms-1` à 16/17, `-ms-[3px]` à 14), `+N` en `text-label` au-delà de `max` | — |
| `WorkingLine` | `avatar: ReactNode`, `label`, `startedAt?: number` | `flex items-center gap-3.5` ; avatar working `size.message` ; `text-working text-muted-foreground` ; durée `font-mono text-mono tabular-nums text-muted-foreground` (réutilise `formatElapsed` de `apps/web/src/components/ai/primitives.tsx`, à déplacer dans `packages/ui-web`) | reduced-motion : durée figée, avatar sans animation |
| `HoverPill` | `children` (boutons `roundIconSm`) | `absolute end-3 -top-3 flex items-center gap-0.5 rounded-full bg-surface p-[3px] shadow-floating` ; apparition `animate-arrive` 160 ms ; repos `opacity-0 pointer-events-none`, révélé au survol/focus du parent (`group-hover`, `group-focus-within`) | — |
| `ComposerShell` | `leading?`, `children` (champ), `trailing` (boutons), `state?: idle \| typing \| dictating \| speaking \| working` | `flex items-center gap-2.5 rounded-full bg-surface shadow-composer py-[7px] pe-[7px] ps-4` ; `leading` (chip de mention) réduit `ps-2.5` ; `trailing` = boutons `roundIcon` 34 px, Send `bg-primary text-primary-foreground`, Stop `bg-secondary` | `dictating` : 4 barres 3×14 px `bg-foreground` animées `rk-bar` 1.1 s ; `working` : 3 points 4 px `rk-dot` 1.2 s + « working » ; `speaking` : avatar 24 px + label + capsule Stop |
| `ReasoningDisclosure` | `summary` (« Thought for 41s · 4 steps »), `open`, `onToggle`, `children`, `live?: boolean` | bouton `text-reasoning text-muted-foreground flex items-center gap-2` + chevron 12 px ; contenu `border-s-[1.5px] border-border ps-3 flex flex-col gap-[9px]` ; dernière ligne en `Shimmer` si `live` | — |

`GroupAvatar` existant reste pour l'avatar composite d'un groupe dans la sidebar (deux avatars 18 px en diagonale dans 28 px).

Mobile (`apps/mobile/components/`) : `framed-block.tsx`, `surface.tsx`, `message-row.tsx`, `user-bubble.tsx`, `interstitial.tsx`, `stacked-avatars.tsx`, `working-line.tsx`, `composer-shell.tsx` : mêmes noms, mêmes props, mêmes nombres, en `StyleSheet` + tokens via `lib/appearance` ; chrome système en `PlatformColor` via `lib/native`.

---

## 3. Écrans — anatomie

### 3.1 Shell (web / desktop)
- Deux volets : `aside` sidebar `w-sidebar bg-sidebar` (pas de bordure droite), `main` pleine largeur `bg-background`. Le panneau droit est `absolute inset-y-0 end-0 z-30 w-panel bg-surface border-s border-border shadow-card`, fermé par Escape et par son X ; le fil reste cliquable derrière.
- Sidebar header `h-header px-4 ps-[18px] flex items-center justify-between` : à gauche bouton icône « Hide bots » (26 px, `roundIconSm`) puis bouton texte « Search » (`text-sm text-muted-foreground` + loupe 15 px) ; à droite « Activity » (cloche 16 px, point 5 px `bg-foreground` avec anneau `ring-2 ring-sidebar` si activité) et « New » (+ 16 px).
- Sections : libellé `text-label text-muted-foreground px-2.5 pt-1 pb-1.5` (« Personal », puis le nom de chaque espace `pt-5`).
- Ligne : `rounded-row px-2.5 py-[9px] gap-[11px]` ; `BotAvatar` 28 ; nom `text-rowName` (+ point 5 px `bg-foreground` = a besoin de toi) ; état `text-rowStatus text-foreground-subtle truncate` ; sélectionnée `bg-sidebar-accent shadow-row font-medium` ; survol `bg-sidebar-accent` ; bot silencieux : nom en `text-muted-foreground`.
- Bas : « Customize » (icône sliders 16 px + `text-[13.5px]`… → `text-meta`), puis compte (initiales 24 px `bg-accent text-muted-foreground text-[10.5px] font-medium` + nom `text-meta text-foreground`).
- Header du fil `h-header px-[22px] flex items-center justify-between`, **sans bordure basse** : titre `text-title` + `StackedAvatars` 20 des bots du groupe ; à droite bouton « Computer & routines » (`tertiary`, icône moniteur 17 px + libellé ; sur écran étroit icône seule avec `aria-label`).
- Colonne du fil : `mx-auto w-full max-w-thread px-3.5 flex flex-col gap-7` (28 px entre messages) ; marqueur de jour `self-center text-label text-muted-foreground`.
- Le `ShellSkeleton` d'`App.tsx` utilise `w-sidebar` et `h-header`.

### 3.2 Messages
- Bot : `MessageRow` (avatar 26, nom, heure, prose, ligne de preuve). Aucun fond, aucune bordure.
- Utilisateur : `UserBubble`.
- Délégation (`bot_message_sent`, `bot_message_received`, `handoff`) : `Interstitial` avec `StackedAvatars` 17 et un texte du type « A asked B for … · 40s › ».
- Raisonnement (`steps`) : `ReasoningDisclosure`, résumé « Thought for {durée} · {n} steps » (durée depuis `steps.durationMs`, formatée `41s` / `2m 04s`) ; le contenu ouvert liste les libellés d'étapes en `text-reasoning text-muted-foreground`, la dernière en `Shimmer` tant que le run vit. Le réglage « Display agent steps » existant continue de gouverner l'affichage.
- Tableau markdown : `Surface` radius card ; en-tête `text-time text-muted-foreground border-b border-border px-3 py-[9px]` ; lignes `text-sm tabular-nums px-3 py-2.5 border-b border-border/60` ; colonnes numériques alignées à droite.
- Bloc de code : `Surface` ; contenu `font-mono text-mono` ; bouton Copy `roundIcon` 32 px `bg-secondary` en fin de ligne.
- Réponses rapides après un message : `quickReply` 32 px, `flex-wrap gap-2 mt-3`, arrivée décalée 60 ms ; disparaissent quand l'utilisateur répond.
- Pendant un run : `WorkingLine` en bas du fil, rien d'autre n'anime.

### 3.3 Blocs cadrés (les seuls éléments cadrés du fil)
- Demande d'action (`ask` approval, consequential) : `FramedBlock` `header.who` = « {Bot} needs your call », question = texte de la demande, conséquence = `detail` s'il existe, actions = primaire `capsule` (`consequential` si `isApprovalAskBlock`) + `capsuleSecondary` + `tertiary`. Libellés existants inchangés (« Allow once », « Always allow this tool », « Deny »).
- Question du bot (`ask` libre, `ask_user` v2, `choice`) : même `FramedBlock`, contrôles : options en `quickReply` (sélection = `capsule`), segmenté si ≤ 4 options courtes et exclusives, champ texte pour le libre ; pied `flex justify-between` : bouton `tertiary` existant (Skip / Other) à gauche, `capsule` « Send » à droite. Un seul bloc ouvert par fil.
- Répondu : actions remplacées par « Answered: … » en `text-meta`.

### 3.4 Composer
- `ComposerShell` ; champ `text-body text-foreground placeholder:text-foreground-subtle`, placeholder « Message {name} » (existant).
- Boutons `roundIcon` 34 : Attach (+), Dictate (micro, conditionnel au provider voix, comportement existant), Send (`bg-primary`, flèche haut 16 px, **visible seulement si le brouillon ou une chip est non vide**, arrivée `animate-arrive`), Stop (`bg-secondary`, carré 12 px) pendant un run.
- Chip de mention : `h-[30px] rounded-full bg-chat-user ps-[5px] pe-2.5 gap-1.5 text-sm` + `BotAvatar` 18.
- États : `idle`, `typing`, `mention`, `dictating`, `speaking`, `working` (voir §2). La logique (mention picker, slash picker, rewind chips, erreurs) ne change pas.

### 3.5 Survol d'un message
- `HoverPill` en haut à droite (`end`) de la ligne : Reply · React · Copy · Speak · More, boutons `roundIconSm` 28. Confirm et Save sont vague 2. « Speak this reply » garde son `aria-label`. `message-hover-time` reste affiché à côté de la pill.

### 3.6 Appel vocal (web)
- `CallView` occupe la colonne du fil (plus de dialog centré) : header `h-header` avec titre + durée `font-mono text-mono tabular-nums` ; centre : conteneur 200 px avec halo `bg-[bot] opacity-50 blur-[28px] animate-[rk-halo_3.2s]` derrière `BotAvatar` 120 working ; sous l'avatar 5 barres 3×16 px `rk-bar` + « {Bot} is speaking » `text-working text-foreground` ; transcription `max-w-[620px]` : ligne utilisateur `text-body text-foreground-subtle text-end`, ligne bot `text-[19px]/1.5 text-foreground` + caret ; réponses rapides `quickReply` + « ou dis-le » `text-meta` ; bas : trois boutons `call` 52 px (Mute et « Switch to text » `bg-secondary`, « End call » `bg-primary`).

### 3.7 Mobile
- Inbox (`app/index.tsx`) : lignes avatar 28 + `rowName` + `rowStatus`, point encre si besoin, pas de carte ; séparateurs et pressed en `PlatformColor`.
- Header du fil (`navigation.setOptions`) : `headerLeft` bouton Bots (icône panneau), `headerTitle` = titre 17/600 + `StackedAvatars` 16 en dessous, `headerRight` = symbole Computer → `router.push("/computer")` ; actions du bot en appui long sur le titre (`showBotActions` existant).
- Fil : `MessageRow` (avatar 26, gap 11), `UserBubble` (`maxWidth 84%`, 16/1.45), `Interstitial` 16, `WorkingLine`, `ReasoningDisclosure` natif (agent-steps).
- Composer : `ComposerShell` natif, `pb` selon safe area, Dictate + Attach, Send apparaît avec du texte, Stop pendant un run.
- Bloc cadré : `FramedBlock` `marginStart 37`, capsules empilées 44 pt (primaire, secondaire, tertiaire 40 pt).
- Cartes : `Surface` radius 14. Dark : mêmes tokens.

---

## 4. Contrat de stabilité — testids et noms accessibles à préserver

`shell-root`, `bots-sidebar`, `bots-sidebar-edge`, `minimize-bots-sidebar`, `restore-bots-sidebar`, `sidebar-search`, `create-menu-trigger`, `[data-sidebar-group]`, `[data-roster-bot-id]`, `bot-settings-trigger`, `side-panel` + `data-panel`, `computer-preview`, `transcript`, `[data-message-id]`, `message-bubble-frame`, `message-bot-bubble` (sur le conteneur de prose), `message-user-bubble` (avec `white-space: pre-wrap`), `reply-parent-preview`, `peer-receipt-chip`, `agent-steps-toggle`, `progress-message`, `response`, `message-hover-rail`, `message-hover-actions`, `message-hover-time`, `message-reactions`, `composer-bar`, `mention-chip`, `skill-chip`, `mention-picker`, `slash-picker`, `composer-error*`, `rewind-chip*`, `call-view`, `routine-run-card`, `cloud-agent-card`, `secret-ask-card`, `.rakazo-organic-avatar[data-working]`, `[data-shape-family]`, `[data-eye-pattern]`.

Noms accessibles : placeholder `Message {name}` (`getByPlaceholder(/Message/)`, `getByRole("combobox", { name: /^Message/ })`), boutons « Reply », « More », « Send », « Stop », « Voice », « Attach file », « Speak this reply », « Allow once », « Always allow this tool », « Deny », « Hide bots », « Activity ». Nouveaux noms introduits par la vague 1 (à citer dans la PR) : « Computer & routines » (remplace le `title` « Agent computer »), « End call » (remplace « Hang up »), « Thought for {duration} · {count} steps » (remplace « Steps ({count}) »). Nouveaux testids : `open-computer-panel`, `ask-options` (remplace le xpath sur `space-y-1.5` dans `choice-card.spec.ts` et `consequential-approval.spec.ts`).

Mobile (Maestro) : `testID="skill-chip"`, labels « Send », « Stop », « Attach file », « Message {name} ».

---

## 5. Accessibilité, i18n, RTL, motion

- Texte porteur d'information : `foreground` ou `mutedForeground` (≥ 4,5:1). `foregroundSubtle` uniquement pour la deuxième ligne de la sidebar et les placeholders, toujours doublé d'une autre indication si l'information compte.
- Chaque bouton icône a un nom accessible traduit ; les primitives exposent `aria-label` via props, jamais de copie interne.
- Propriétés logiques partout ; `HoverPill` et panneau en `end`.
- `prefers-reduced-motion` : `animate-arrive`, `rk-bar`, `rk-dot`, `rk-halo`, morph et corps de l'avatar désactivés ; clignement conservé ; durée `WorkingLine` figée.
- Cibles tactiles mobile ≥ 44 pt en pile ; 34 pt en flux pour les réponses rapides seulement.
- Copie : anglaise dans le code, via lingui ; `intl:extract` ; la PR cite et justifie.

---

## 6. Tâches (PR) — critères d'acceptation et risques

Voir le tableau du plan approuvé. Résumé par PR :

| # | PR | Critère d'acceptation | Specs à traiter |
|---|---|---|---|
| 0 | Extraire `Shell.tsx` → `pages/shell/{sidebar,thread-header,side-panel,transcript,composer,message-view,message-hover-actions}.tsx` + `layout.ts` | toutes les régions listées extraites (`ShellPage` garde état, effets et RPC : ~3 100 lignes restent) ; parité exacte des testids et des chaînes lingui ; 65 specs vertes sans modification ; zéro diff visuel | `desktop.test.ts` lit le header depuis son nouveau fichier |
| 1 | Tokens 7 familles + Geist Mono + `Wordmark` en `font-sans` | couleurs mesurées en e2e ; `font-mono` = Geist Mono ; utilitaires `text-*`, `rounded-*`, `shadow-*`, `w-sidebar` existent ; `appearance.test.ts` étendu et vert ; mobile inchangé fonctionnellement | `ui-appearance.spec.ts:84` (`rgb(17,17,20)`) |
| 2 | Avatar `organic` par défaut, sans anneau, `robot` opt-in, migration Prisma du défaut | nouveau compte → organique web + mobile ; working = corps + lueur, pas d'anneau | `group-chats.spec.ts:100`, `router.test.ts:122,138,470`, `bot-avatar.test.tsx` |
| 3 | Primitives §2 + `docs/design-system.md` + phrase dans `AGENTS.md` + `apps/web/e2e/design-system.spec.ts` (fixture `e2e/fixtures/design-system.html`) | chaque primitive testée et capturée light + dark ; grep `#[0-9a-fA-F]{6}`, `text-\[`, `rounded-\[`, `shadow-\[` vide dans les nouveaux fichiers ; aucun écran modifié | aucune |
| 4 | Shell §3.1 | sidebar 280, header 56 sans bordure, fil centré 800, panneau en superposition ouvert par « Computer & routines », Escape ferme | `golden.spec.ts:70-79`, 7 specs `getByTitle("Agent computer")`, `collapsible-sidebar-sections`, `mobile-sidebar-swipe`, `ui-appearance` (alignement search / lignes) |
| 5 | Messages §3.2 | bot sans fond, user bulle 19 ≤ 78 %, interstice centré, durée de raisonnement affichée, tableaux tabular-nums | garder `message-bot-bubble`, `message-user-bubble` pre-wrap (`auth-lifecycle.spec.ts:132`), `peer-receipt-chip`, `agent-steps-toggle`, `progress-message`, `response` ; hover rail inchangé jusqu'à PR 9 |
| 6 | Composer §3.4 | capsule + ombre ; Send conditionnel ; Stop pendant run ; chip 30 px | `voice.spec.ts:12-21`, `composer-paste`, `mention-picker-keyboard`, `slash-skills` |
| 7 | Blocs cadrés §3.3 | seul élément cadré du fil ; en-tête « {Bot} needs your call » ; cadenas si approbation ; libellés inchangés | `choice-card.spec.ts:56`, `consequential-approval.spec.ts:68` → `ask-options` ; `AskCard.test.tsx` |
| 8 | Cartes sur `Surface` | radius 14, `bg-surface`, filet, pas d'ombre, zéro logique | `routine-run-card`, `cloud-agent-card`, `secret-ask-card`, chart links |
| 9 | `WorkingLine`, `HoverPill`, motion §1.6 | une seule animation continue pendant un run ; pill en `end` ; reduced-motion = clignement seul | `message-hover-actions.spec.ts` (géométrie), `voice.spec.ts:62`, `chat-progress-messages`, `tool-activity-disclosure` |
| 10 | Appel vocal §3.6 | plein fil, avatar 120 + halo, 3 boutons 52, `call-view` conservé | `voice.spec.ts:82-83` (« End call ») |
| 11 | Mobile primitives + inbox + header + `elevation` | lignes sans carte ; header 3 zones ; capture Android liée | `pnpm --filter @rakazo/mobile check`, `lib/*.test.ts`, Maestro |
| 12 | Mobile messages + composer | même grammaire que web ; Send conditionnel ; reduced-motion | labels Maestro |
| 13 | Mobile bloc cadré + cartes | capsules 44 pt en pile ; radius 18 / 14 | — |
| 14 | `BOT_COLORS` source unique (optionnel) | une seule définition | — |

Ordre : 0 → 1 → 2 → 3, puis en parallèle web {4}, {5 → 9}, {6}, {7 → 8}, {10} et mobile {11 → 12 → 13}.

## 7. Vérification par PR

1. `pnpm --filter @rakazo/ui-tokens generate` si `ui-tokens/src/index.ts` a changé.
2. `pnpm check && pnpm lint && pnpm test`.
3. `pnpm --filter @rakazo/web intl:extract` si copie ajoutée ; `apps/web/src/lib/i18n-catalog.test.ts` vert.
4. e2e ciblé local sur chaque spec listée « à traiter » ; Playwright complet en CI ; capture light + dark attachée et liée dans la PR (bascule via `ui-appearance-light` / `ui-appearance-dark` dans les réglages, motif de `ui-appearance.spec.ts`).
5. `grep -rn` sur les fichiers touchés : aucun hex, aucun `text-[`, `rounded-[`, `shadow-[`, `w-[`, `h-[` nouveau hors primitives justifiées.
6. `/code-review` (medium, high sur les L) puis `/simplify` avant push ; `pr-digest --watch` jusqu'à zéro retour actionnable.
7. `CHANGELOG.md` : entrée sous `## [Unreleased]` / `### <jour>` (sauf 0, 3, 14).

## 8. Hors scope (vague 2, une PR par mécanique avec spec, design, threat model)

Read receipts (« Seen » + avatars 14), réactions à un verbe (« confirmed » avec avatar, capsule « you »), draft partagé éditable en place, Saved / épingles et section « Saved », « Plus tard » sur une décision, ligne de provenance générique, aperçu de lien, `Segmented` si non utilisé en vague 1, états émotionnels de l'avatar (grammaire des yeux, séquences, présence ambiante), écran d'appel mobile.
