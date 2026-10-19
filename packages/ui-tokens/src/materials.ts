import type { ColorTokens, ResolvedAppearance } from "./index.js";

type PerAppearance = Record<ResolvedAppearance, string>;

/**
 * Glass for navigation and controls, never content: a translucent fill that
 * blurs the ambient light and the thread under it, with a hairline and an
 * inner highlight. Under Reduce Transparency it becomes the opaque `fallback`.
 */
export type Material = {
  fill: PerAppearance;
  edge: PerAppearance;
  /** Backdrop blur, in px. */
  blur: number;
  /** Backdrop saturation, in %. */
  saturate: number;
  fallback: keyof ColorTokens;
};

const overlayEdge = {
  light:
    "inset 0 1px 0 rgba(255, 255, 255, 0.8), 0 0 0 1px rgba(0, 0, 0, 0.08), 0 12px 32px -8px rgba(0, 0, 0, 0.22)",
  dark: "inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 0 0 1px rgba(255, 255, 255, 0.09), 0 16px 40px -10px rgba(0, 0, 0, 0.7)",
} as const satisfies PerAppearance;

export const materials = {
  /** The sidebar. */
  chrome: {
    fill: { light: "rgba(255, 255, 255, 0.68)", dark: "rgba(36, 36, 40, 0.55)" },
    edge: {
      light:
        "inset 0 1px 0 rgba(255, 255, 255, 0.7), 0 0 0 1px rgba(0, 0, 0, 0.07), 0 2px 8px -2px rgba(0, 0, 0, 0.08)",
      dark: "inset 0 1px 0 rgba(255, 255, 255, 0.08), 0 0 0 1px rgba(255, 255, 255, 0.07), 0 2px 8px -2px rgba(0, 0, 0, 0.4)",
    },
    blur: 30,
    saturate: 160,
    fallback: "sidebar",
  },
  /** The header's action capsule, the composer, the hover pill, round buttons. */
  control: {
    fill: { light: "rgba(255, 255, 255, 0.6)", dark: "rgba(44, 44, 48, 0.6)" },
    edge: {
      light:
        "inset 0 1px 0 rgba(255, 255, 255, 0.7), 0 0 0 1px rgba(0, 0, 0, 0.08), 0 2px 8px -2px rgba(0, 0, 0, 0.1)",
      dark: "inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 0 0 1px rgba(255, 255, 255, 0.08), 0 2px 8px -2px rgba(0, 0, 0, 0.5)",
    },
    blur: 12,
    saturate: 170,
    fallback: "card",
  },
  /** Small menus and tooltips: a step more opaque, to stay legible over thread text. */
  menu: {
    fill: { light: "rgba(255, 255, 255, 0.8)", dark: "rgba(44, 44, 48, 0.8)" },
    edge: overlayEdge,
    blur: 30,
    saturate: 180,
    fallback: "card",
  },
  /** Dense lists: the palette, the bot drawer at phone width. */
  list: {
    fill: { light: "rgba(250, 250, 251, 0.94)", dark: "rgba(40, 40, 44, 0.94)" },
    edge: overlayEdge,
    blur: 40,
    saturate: 180,
    fallback: "card",
  },
} as const satisfies Record<string, Material>;

export type MaterialKey = keyof typeof materials;

/**
 * The neutral light falling from the top start corner over the whole window,
 * under the floating sidebar too, so the glass has something to blur. Phone
 * width has its own values, higher and from the corner, and ends in the page
 * background at the bottom edge: Safari paints its toolbar in that colour.
 */
export const ambient = {
  desktop: {
    light:
      "radial-gradient(120% 90% at 0% 0%, #ffffff 0%, rgba(255, 255, 255, 0) 62%), linear-gradient(160deg, #f6f6f8 0%, #e8e8ec 100%)",
    dark: "radial-gradient(110% 85% at 34% 0%, #303035 0%, rgba(48, 48, 53, 0) 62%), linear-gradient(165deg, #1e1e21 0%, #0d0d0e 100%)",
  },
  narrow: {
    light:
      "linear-gradient(to top, #f2f2f4 0%, rgba(242, 242, 244, 0) 22%), radial-gradient(130% 62% at 0% 0%, #ffffff 0%, rgba(255, 255, 255, 0) 100%), linear-gradient(165deg, #f3f3f5 0%, #e2e2e7 100%)",
    dark: "linear-gradient(to top, #161618 0%, rgba(22, 22, 24, 0) 22%), radial-gradient(130% 62% at 0% 0%, #36363c 0%, rgba(54, 54, 60, 0) 100%), linear-gradient(165deg, #19191c 0%, #0c0c0d 100%)",
  },
} as const satisfies Record<string, PerAppearance>;

/** Widths below this take the `narrow` ambient (Tailwind's `md`). */
export const narrowMaxWidth = 767;

/** The scroll edge's backdrop blur under the header, in px. */
export const scrollEdgeBlur = 20;

/**
 * Where the thread fades, in px: in under the header from `topStart` to
 * `topEnd`; at the bottom it runs `underComposer` px under the composer (its
 * 12 top inset, 48 bar and 20 bottom gap) and fades out across the bar, opaque
 * `bottomStart` px above the window's edge and gone `bottomEnd` px above it, so
 * the glass has the thread to blur and nothing shows in the gap below.
 */
export const threadFade = {
  topStart: 60,
  topEnd: 84,
  bottomStart: 68,
  bottomEnd: 20,
  underComposer: 80,
} as const;
