/** `receipt`, `stackXs`, `interstitial` and `stack` from the `sizes` tokens, plus
 * `28` — the header's own avatar-stack variant, used for the multibot thread
 * header and the peer-messages header (design contract §C / §D). */
export type StackedAvatarSize = 14 | 16 | 17 | 20 | 28;

/** How far each avatar slides under the one before it, per stack size — mirrors
 * `packages/ui-web/src/stacked-avatars.tsx`'s `OVERLAP` (in px, native `marginStart`). */
export const STACKED_AVATAR_OVERLAP: Record<StackedAvatarSize, number> = {
  14: 3,
  16: 4,
  17: 4,
  20: 5,
  28: 7,
};

export interface StackedAvatarsLayout<T> {
  shown: T[];
  overflow: number;
}

/** Which items render as an avatar vs collapse into the `+N` label. */
export function stackedAvatarsLayout<T>(items: T[], max: number): StackedAvatarsLayout<T> {
  const shown = items.slice(0, max);
  return { shown, overflow: items.length - shown.length };
}
