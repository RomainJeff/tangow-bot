export const APPEARANCE_PREFERENCES = ["system", "light", "dark"] as const;

export type AppearancePreference = (typeof APPEARANCE_PREFERENCES)[number];

export type ResolvedAppearance = "light" | "dark";

export const UI_APPEARANCE_STORAGE_KEY = "rakazo.uiAppearance";

/**
 * Semantic palette shared by web, Electron, and Expo. Names follow the shadcn
 * convention so the same slot means the same thing on every surface: a `border`
 * is always a border and never a fill.
 */
export type ColorTokens = {
  background: string;
  foreground: string;
  foregroundSubtle: string;
  card: string;
  cardForeground: string;
  popover: string;
  popoverForeground: string;
  primary: string;
  primaryForeground: string;
  secondary: string;
  secondaryForeground: string;
  chatUser: string;
  chatUserForeground: string;
  mentionChip: string;
  mentionChipForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  border: string;
  outline: string;
  input: string;
  ring: string;
  sidebar: string;
  sidebarForeground: string;
  sidebarBorder: string;
  sidebarAccent: string;
  sidebarAccentForeground: string;
  surface: string;
  link: string;
  success: string;
  warning: string;
  overlay: string;
  scrollbar: string;
  scrollbarHover: string;
};

// Alpha overlays from the design are flattened on `background` so every slot
// stays opaque (opacity modifiers and color-mix must keep working).
export const darkTokens = {
  background: "#0C0C0E",
  foreground: "#F2F2F0",
  foregroundSubtle: "#6E6E73",
  card: "#161618",
  cardForeground: "#F2F2F0",
  popover: "#161618",
  popoverForeground: "#F2F2F0",
  primary: "#F2F2F0",
  primaryForeground: "#0C0C0E",
  secondary: "#1F1F21",
  secondaryForeground: "#F2F2F0",
  chatUser: "#3E3E44",
  chatUserForeground: "#F2F2F0",
  mentionChip: "#222226",
  mentionChipForeground: "#F2F2F0",
  muted: "#1F1F21",
  mutedForeground: "#9A9AA1",
  accent: "#1B1B1C",
  accentForeground: "#F2F2F0",
  destructive: "#EF4444",
  destructiveForeground: "#FFFFFF",
  border: "#1F1F21",
  outline: "#333335",
  input: "#29292B",
  ring: "#9A9AA1",
  sidebar: "#131315",
  sidebarForeground: "#F2F2F0",
  sidebarBorder: "#1F1F21",
  sidebarAccent: "#1D1D1F",
  sidebarAccentForeground: "#F2F2F0",
  surface: "#161618",
  link: "#86B7FF",
  success: "#4ECB71",
  warning: "#E9C46A",
  overlay: "rgba(4, 4, 5, 0.72)",
  scrollbar: "#1E2026",
  scrollbarHover: "#2E313A",
} as const satisfies ColorTokens;

export const lightTokens = {
  background: "#FBFBF9",
  foreground: "#111114",
  foregroundSubtle: "#86868B",
  card: "#FFFFFF",
  cardForeground: "#111114",
  popover: "#FFFFFF",
  popoverForeground: "#111114",
  primary: "#111114",
  primaryForeground: "#FBFBF9",
  secondary: "#EDEDEB",
  secondaryForeground: "#111114",
  chatUser: "#111114",
  chatUserForeground: "#FBFBF9",
  mentionChip: "#F1F1EE",
  mentionChipForeground: "#111114",
  muted: "#EDEDEB",
  mutedForeground: "#6E6E73",
  accent: "#EFEFEE",
  accentForeground: "#111114",
  destructive: "#DC2626",
  destructiveForeground: "#FFFFFF",
  border: "#E8E8E7",
  outline: "#DADAD9",
  input: "#DFDFDE",
  ring: "#6E6E73",
  sidebar: "#F4F4F3",
  sidebarForeground: "#111114",
  sidebarBorder: "#E8E8E7",
  sidebarAccent: "#FFFFFF",
  sidebarAccentForeground: "#111114",
  surface: "#FFFFFF",
  link: "#2563EB",
  success: "#228B3B",
  warning: "#B7791F",
  overlay: "rgba(20, 20, 22, 0.45)",
  scrollbar: "#C8C8C4",
  scrollbarHover: "#A8A8A4",
} as const satisfies ColorTokens;

/** Dark palette. Prefer `tokensForAppearance` when theme-aware. */
export const tokens = darkTokens;

export const RADIUS = "0.75rem";

export const botColors = [
  "#00C46A",
  "#3BC9A0",
  "#2E8CF0",
  "#8B5CF6",
  "#E45C9C",
  "#E0524A",
  "#F0913A",
] as const;

/**
 * Typography — one scale for every surface that renders prose or UI labels.
 * `tracking` is a CSS letter-spacing value (an em string, or `"0"`); `weight`
 * is the base font-weight (some screens layer a heavier weight on top, e.g.
 * a selected sidebar row or a primary capsule — see the design contract).
 */
export type TypographyToken = {
  size: number;
  leading: number;
  tracking: string;
  weight: number;
};

export const typography = {
  body: { size: 16.5, leading: 1.58, tracking: "-0.008em", weight: 400 },
  author: { size: 13, leading: 1.3, tracking: "-0.004em", weight: 500 },
  time: { size: 12, leading: 1.3, tracking: "0", weight: 400 },
  meta: { size: 13, leading: 1.4, tracking: "0", weight: 400 },
  label: { size: 12.5, leading: 1.3, tracking: "0", weight: 400 },
  rowName: { size: 14.5, leading: 1.3, tracking: "-0.005em", weight: 400 },
  rowStatus: { size: 12.5, leading: 1.3, tracking: "0", weight: 400 },
  title: { size: 19, leading: 1.2, tracking: "-0.014em", weight: 500 },
  capsule: { size: 14, leading: 1, tracking: "0", weight: 400 },
  working: { size: 15, leading: 1.3, tracking: "-0.006em", weight: 400 },
  reasoning: { size: 13.5, leading: 1.45, tracking: "0", weight: 400 },
  blockHeader: { size: 12.5, leading: 1.3, tracking: "0.01em", weight: 500 },
  question: { size: 16, leading: 1.45, tracking: "-0.008em", weight: 400 },
  mono: { size: 12.5, leading: 1.3, tracking: "0", weight: 400 },
  /** The mobile composer field: the native iOS body, 17/22. */
  composer: { size: 17, leading: 1.294, tracking: "-0.01em", weight: 400 },
} as const satisfies Record<string, TypographyToken>;

export type TypographyKey = keyof typeof typography;
export type TypographyTokens = typeof typography;

/** Space — layout dimensions from the Quiet grid, in px. */
export const space = {
  sidebar: 280,
  thread: 800,
  header: 56,
  panel: 384,
  /** A framed block standing alone in the thread: `max-w-block`. */
  block: 520,
  /** Web/desktop composer field: `max-h-composer-field` before it scrolls internally. */
  composerField: 220,
} as const satisfies Record<string, number>;

export type SpaceKey = keyof typeof space;
export type SpaceTokens = typeof space;

/** Radii — in px. `pill` is expressed as `rounded-full` on the surfaces, not a radius var. */
export const radii = {
  chip: 6,
  row: 11,
  card: 14,
  draft: 16,
  block: 18,
  bubble: 18,
  composer: 24,
  pill: 9999,
} as const satisfies Record<string, number>;

export type RadiusKey = keyof typeof radii;
export type RadiiTokens = typeof radii;

/** Elevation — the only shadows in the product, one per screen at most. */
export const lightShadows = {
  row: "0 1px 2px rgba(17, 17, 20, 0.06)",
  card: "0 0 0 1px rgba(17, 17, 20, 0.08), 0 12px 30px -16px rgba(17, 17, 20, 0.4)",
  /** A decision once answered: the card's hairline without its drop, so it gives the thread back its one elevation. */
  settled: "0 0 0 1px rgba(17, 17, 20, 0.08)",
  /** The composer at rest: a hairline, no drop shadow. */
  composerRest: "0 0 0 1px rgba(17, 17, 20, 0.09)",
  /** The composer while its field has focus: the hairline and the one drop shadow. */
  composerFocus: "0 0 0 1px rgba(17, 17, 20, 0.09), 0 12px 28px -18px rgba(17, 17, 20, 0.55)",
  floating: "0 1px 2px rgba(17, 17, 20, 0.08), 0 8px 20px -10px rgba(17, 17, 20, 0.35)",
} as const satisfies Record<string, string>;

export type ShadowKey = keyof typeof lightShadows;
export type ShadowTokens = Record<ShadowKey, string>;

export const darkShadows = {
  row: "none",
  card: "0 0 0 1px rgba(255, 255, 255, 0.08), 0 12px 30px -16px rgba(0, 0, 0, 0.8)",
  settled: "0 0 0 1px rgba(255, 255, 255, 0.08)",
  composerRest: "0 0 0 1px rgba(255, 255, 255, 0.08)",
  // A drop shadow barely reads on a near-black page, so focus also brightens the hairline.
  composerFocus: "0 0 0 1px rgba(255, 255, 255, 0.16), 0 12px 28px -18px rgba(0, 0, 0, 0.8)",
  floating: "0 0 0 1px rgba(255, 255, 255, 0.08), 0 8px 20px -10px rgba(0, 0, 0, 0.7)",
} as const satisfies ShadowTokens;

export function shadowsForAppearance(appearance: ResolvedAppearance): ShadowTokens {
  return appearance === "light" ? lightShadows : darkShadows;
}

/**
 * Motion — one easing curve, everything else is a duration in ms. Nothing
 * loops continuously except the working-avatar body, its idle breathing and
 * the Stop button's contour while a reply streams.
 */
export type MotionTokens = {
  ease: string;
  arrive: number;
  press: number;
  hover: number;
  breathe: number;
  caret: number;
  /** The send arrow pivoting in with the first character. */
  pivot: number;
  /** The mobile attach button turning into a close button while its sheet is open. */
  morph: number;
  /** One lap of the Stop contour while a reply streams. */
  flow: number;
};

export const motion: MotionTokens = {
  ease: "cubic-bezier(0.32, 0.72, 0, 1)",
  arrive: 240,
  press: 160,
  hover: 160,
  breathe: 5600,
  caret: 1000,
  pivot: 320,
  morph: 260,
  flow: 2600,
};

/** Sizes — avatars and round controls, in px. Consumed via primitive `size` props. */
export const sizes = {
  receipt: 14,
  stackXs: 16,
  interstitial: 17,
  chip: 18,
  stack: 20,
  message: 26,
  row: 28,
  call: 120,
  hoverIcon: 28,
  quickReply: 32,
  composerIcon: 34,
  /** Mobile: the detached attach bubble. */
  composerAttach: 48,
  /** Mobile: the touch target of a button inside the capsule. */
  composerTarget: 44,
  /** Mobile: the send / stop disc inside a target. */
  composerAction: 36,
  capsule: 36,
  mobileStack: 44,
  callButton: 52,
  /** The composer's attachment thumbnail / file-tile height (both devices). */
  composerAttachmentThumb: 64,
  /** Max width of a composer file tile before its name truncates. */
  composerAttachmentTile: 200,
  /** The × disc on a composer attachment. */
  composerRemove: 22,
} as const satisfies Record<string, number>;

export type SizeKey = keyof typeof sizes;
export type SizeTokens = typeof sizes;

export function isAppearancePreference(
  value: string | null | undefined,
): value is AppearancePreference {
  return value === "system" || value === "light" || value === "dark";
}

export function normalizeAppearancePreference(
  raw: string | null | undefined,
): AppearancePreference {
  return isAppearancePreference(raw) ? raw : "system";
}

export type ResolveAppearancePreferenceOptions = {
  stored?: string | null;
  storage?: Pick<Storage, "getItem"> | null;
};

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

export function resolveAppearancePreference(
  options: ResolveAppearancePreferenceOptions = {},
): AppearancePreference {
  const stored =
    options.stored !== undefined
      ? options.stored
      : readStoredAppearance(options.storage ?? getLocalStorage());
  return normalizeAppearancePreference(stored);
}

export function persistAppearancePreference(
  preference: AppearancePreference,
  storage: Pick<Storage, "setItem"> | null = getLocalStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(UI_APPEARANCE_STORAGE_KEY, preference);
  } catch {
    // Ignore quota / private-mode failures; in-memory preference still applies.
  }
}

export function resolveAppearance(
  preference: AppearancePreference,
  system: ResolvedAppearance = "dark",
): ResolvedAppearance {
  if (preference === "system") return system;
  return preference;
}

export function tokensForAppearance(appearance: ResolvedAppearance): ColorTokens {
  return appearance === "light" ? lightTokens : darkTokens;
}

/** WCAG relative luminance (0..1) of a `#rrggbb` colour. */
export function relativeLuminance(hex: string): number {
  const clean = hex.replace(/^#/, "");
  const channel = (offset: number) => {
    const c = Number.parseInt(clean.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio (1..21) between two `#rrggbb` colours. */
export function contrastRatio(a: string, b: string): number {
  const luminanceA = relativeLuminance(a);
  const luminanceB = relativeLuminance(b);
  return (Math.max(luminanceA, luminanceB) + 0.05) / (Math.min(luminanceA, luminanceB) + 0.05);
}

/**
 * A bot's colour for a thin mark drawn on the page (the Stop contour), or
 * `undefined` when it would not read against that appearance's background —
 * the near-black bot colour on dark, white on light. 3:1 is WCAG's floor for
 * non-text graphics.
 */
export function botAccentOn(
  color: string | undefined,
  appearance: ResolvedAppearance,
): string | undefined {
  if (!color || !/^#[0-9a-f]{6}$/i.test(color)) return undefined;
  return contrastRatio(color, tokensForAppearance(appearance).background) >= 3 ? color : undefined;
}

function readStoredAppearance(storage: Pick<Storage, "getItem"> | null | undefined): string | null {
  if (!storage) return null;
  try {
    return storage.getItem(UI_APPEARANCE_STORAGE_KEY);
  } catch {
    return null;
  }
}

/** `cardForeground` -> `card-foreground` (no leading `--`). */
function kebabCase(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** `cardForeground` -> `--card-foreground` */
export function cssVariableName(token: keyof ColorTokens): string {
  return `--${kebabCase(token)}`;
}

/** `biome`'s CSS formatter (100-col `lineWidth`) wraps a declaration that
 * doesn't fit on one line onto two, indenting the value by 4 spaces: this
 * keeps a fresh `generate` byte-identical to what `biome check --write`
 * would produce, so `tokens.css` never has to be reformatted by hand. */
function renderDeclaration(name: string, value: string): string {
  const oneLine = `  ${name}: ${value};`;
  return oneLine.length <= 100 ? oneLine : `  ${name}:\n    ${value};`;
}

function renderShadowLines(appearance: ResolvedAppearance): string[] {
  const palette = shadowsForAppearance(appearance);
  return (Object.keys(palette) as ShadowKey[]).map((key) =>
    renderDeclaration(`--elevation-${kebabCase(key)}`, palette[key]),
  );
}

function renderTypographyLines(): string[] {
  return (Object.keys(typography) as TypographyKey[]).flatMap((key) => {
    const token = typography[key];
    const name = `type-${kebabCase(key)}`;
    return [
      `  --${name}-size: ${token.size}px;`,
      `  --${name}-leading: ${token.leading};`,
      `  --${name}-tracking: ${token.tracking};`,
      `  --${name}-weight: ${token.weight};`,
    ];
  });
}

function renderSpaceLines(): string[] {
  return (Object.keys(space) as SpaceKey[]).map(
    (key) => `  --space-${kebabCase(key)}: ${space[key]}px;`,
  );
}

function renderRadiiLines(): string[] {
  return (Object.keys(radii) as RadiusKey[]).map(
    (key) => `  --corner-${kebabCase(key)}: ${radii[key]}px;`,
  );
}

function renderSizeLines(): string[] {
  return (Object.keys(sizes) as SizeKey[]).map(
    (key) => `  --size-${kebabCase(key)}: ${sizes[key]}px;`,
  );
}

function renderMotionLines(): string[] {
  const durationKeys = (Object.keys(motion) as (keyof MotionTokens)[]).filter(
    (key): key is Exclude<keyof MotionTokens, "ease"> => key !== "ease",
  );
  const lines = durationKeys.map((key) => `  --duration-${kebabCase(key)}: ${motion[key]}ms;`);
  lines.push(`  --motion-ease: ${motion.ease};`);
  return lines;
}

function renderBlock(
  selector: string,
  colorScheme: ResolvedAppearance,
  palette: ColorTokens,
): string {
  const lines = (Object.keys(palette) as (keyof ColorTokens)[]).map(
    (token) => `  ${cssVariableName(token)}: ${palette[token].toLowerCase()};`,
  );
  lines.push(`  --radius: ${RADIUS};`);
  lines.push(...renderShadowLines(colorScheme));
  return `${selector} {\n  color-scheme: ${colorScheme};\n${lines.join("\n")}\n}`;
}

function renderThemeIndependentBlock(): string {
  const lines = [
    ...renderTypographyLines(),
    ...renderSpaceLines(),
    ...renderRadiiLines(),
    ...renderSizeLines(),
    ...renderMotionLines(),
  ];
  return `:root {\n${lines.join("\n")}\n}`;
}

/** The CSS in `tokens.css`. Generated from the TS palette so both stay in sync. */
export function renderTokensCss(): string {
  return `${[
    "/* Generated by `pnpm --filter @rakazo/ui-tokens generate`. Edit src/index.ts instead. */",
    renderBlock(':root,\n[data-theme="dark"]', "dark", darkTokens),
    renderBlock('[data-theme="light"]', "light", lightTokens),
    renderThemeIndependentBlock(),
  ].join("\n\n")}\n`;
}
