import type { LinkMentionLookup } from "@rakazo/core";
import { linkMentionLabel } from "@rakazo/core";
import type { ColorTokens } from "@rakazo/ui-tokens";
import { radii, sizes } from "@rakazo/ui-tokens";
import type { ReactNode } from "react";
import type { TextProps } from "react-native";
import { StyleSheet, Text, View } from "react-native";
import { linkUnderline, USER_LINK_UNDERLINE, veil } from "./link-underline";

/**
 * A message's mentions on a phone. The host fills the icon frame: the site's icon read from the
 * thread's artifact, or the link glyph in `tint` when there is none (`artifactId` undefined) or it
 * cannot be read.
 */
export interface NativeLinkMentions extends LinkMentionLookup {
  icon(artifactId: string | undefined, tint: string): ReactNode;
}

/** The colours a mention takes from its bubble. */
export interface LinkMentionTone {
  tile: string;
  hairline?: string;
  glyph: string;
  underline: string;
}

/** A bot bubble: the `linkMentionTile` tile with a 10% hairline, so any icon reads on it. */
export function botLinkMentionTone(palette: ColorTokens): LinkMentionTone {
  return {
    tile: palette.linkMentionTile,
    hairline: veil(palette.foreground, 0.1),
    glyph: palette.mutedForeground,
    underline: linkUnderline(palette.foreground),
  };
}

/** The person's bubble: a 14% veil of its ink and no hairline; the glyph takes the ink. */
export function personLinkMentionTone(ink: string): LinkMentionTone {
  return {
    tile: veil(ink, 0.14),
    glyph: ink,
    underline: linkUnderline(ink, USER_LINK_UNDERLINE),
  };
}

/** Keeps the icon and the label's first word on one line. */
const WORD_JOINER = "\u2060";

/**
 * The mention a link of this message resolves to, or undefined when it stays a plain link. It is
 * a `Text` nested in the sentence, so the paragraph keeps one layout and one selection: the icon
 * is an inline view (iOS sets an attachment's bottom on the line's descender, which about centres
 * a 16 pt frame on a 23 pt line), and the label wraps like the words around it, since nested text
 * cannot ellipsize.
 */
export function nativeLinkMention({
  mentions,
  href,
  authorText,
  tone,
  style,
  onPress,
  onLongPress,
  key,
}: {
  mentions: NativeLinkMentions | undefined;
  href: string;
  authorText: string;
  tone: LinkMentionTone;
  /** The sentence's text style, when the mention does not inherit it. */
  style?: TextProps["style"];
  onPress: () => void;
  onLongPress?: TextProps["onLongPress"];
  key?: string | number;
}): ReactNode | undefined {
  const block = mentions?.find(href);
  if (!mentions || !block) return undefined;
  const label = linkMentionLabel({ href, authorText, block });
  return (
    <Text
      key={key}
      accessibilityRole="link"
      style={style}
      onPress={onPress}
      onLongPress={onLongPress}
    >
      <View
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={styles.frame}
      >
        <View style={[styles.tile, { backgroundColor: tone.tile }]}>
          {tone.hairline ? (
            <View style={[styles.hairline, { borderColor: tone.hairline }]} />
          ) : null}
          {mentions.icon(block.icon?.artifactId, tone.glyph)}
        </View>
      </View>
      {WORD_JOINER}
      <Text
        style={[styles.label, { textDecorationColor: tone.underline }]}
      >{`\u2068${label}\u2069`}</Text>
    </Text>
  );
}

const styles = StyleSheet.create({
  // The gap is part of the inline view: nested text has no margins to lend it.
  frame: {
    width: sizes.linkMentionIcon + sizes.linkMentionGap,
    height: sizes.linkMentionIcon,
  },
  tile: {
    width: sizes.linkMentionIcon,
    height: sizes.linkMentionIcon,
    borderRadius: radii.linkMention,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  // Under the icon, like the web's inset shadow: an opaque icon covers it.
  hairline: {
    ...StyleSheet.absoluteFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radii.linkMention,
  },
  label: {
    textDecorationLine: "underline",
  },
});
