import { type ColorTokens, darkTokens, type ResolvedAppearance } from "@rakazo/ui-tokens";
import Markdown, {
  createMarkdownIt,
  MarkdownStream,
  type RenderRules,
} from "@ronradtke/react-native-markdown-display";
import { memo, useMemo } from "react";
import type { TextProps } from "react-native";
import { Linking, StyleSheet, Text, View } from "react-native";
import type { ChatMarkdownProps } from "./markdown";
import { linkHref, linkifyText, nativeImagePolicy, repairMarkdownTables } from "./markdown";
import type { GridNode } from "./table-grid.native";
import { TableGrid } from "./table-grid.native";
import { TABLE_CELL_PADDING_X } from "./table-layout";

/**
 * `inBubble` (design contract §B "Markdown dans une bulle"): a bot bubble's
 * padding (10 × 14) is not a surface an inline element can reuse, so code and
 * tables need their own rules inside it. Everything else (a `Surface` card,
 * `FramedBlock`, an artifact preview) renders exactly as before — this only
 * changes `table`/`tr`/`th`/`td` (no surface fill, `border` hairlines bleeding
 * to the bubble's edge, cells aligned on its 14 px padding, horizontal scroll
 * for a wide table) and the bubble's own body/paragraph size (16/1.45 per
 * design contract §3.7, vs the shared 15.5/23 used outside a bubble).
 */
function markdownStyles(palette: ColorTokens, inBubble: boolean) {
  return StyleSheet.create({
    body: inBubble
      ? {
          color: palette.foreground,
          fontSize: 16,
          lineHeight: 23,
          // A bubble fits its content: no `width: "100%"` here or on the
          // paragraph, which would resolve against an indefinite width and
          // measure the text wider than the bubble draws it.
          minWidth: 0,
          // Cancels the last paragraph's bottom margin so the bubble's padding
          // reads the same above and below the text.
          marginBottom: -9,
          flexShrink: 1,
        }
      : {
          color: palette.foreground,
          fontSize: 15.5,
          lineHeight: 23,
          width: "100%",
          minWidth: 0,
          flexShrink: 1,
        },
    paragraph: inBubble
      ? { marginTop: 0, marginBottom: 9, width: "auto", flexShrink: 1 }
      : { marginTop: 0, marginBottom: 9, width: "100%", flexShrink: 1 },
    heading1: {
      color: palette.foreground,
      fontSize: 21,
      lineHeight: 27,
      marginTop: 10,
      marginBottom: 5,
    },
    heading2: {
      color: palette.foreground,
      fontSize: 19,
      lineHeight: 25,
      marginTop: 10,
      marginBottom: 5,
    },
    heading3: {
      color: palette.foreground,
      fontSize: 17,
      lineHeight: 23,
      marginTop: 8,
      marginBottom: 4,
    },
    strong: {
      color: palette.foreground,
      fontWeight: "700",
    },
    link: {
      color: palette.link,
      textDecorationLine: "underline",
      marginBottom: 0,
    },
    code_inline: {
      color: palette.foreground,
      backgroundColor: palette.background,
      borderColor: palette.border,
      borderWidth: StyleSheet.hairlineWidth,
      padding: 0,
      paddingHorizontal: 4,
      paddingVertical: 1,
      borderRadius: 4,
    },
    code_block: {
      color: palette.foreground,
      backgroundColor: palette.background,
      borderColor: palette.border,
    },
    fence: {
      backgroundColor: palette.background,
      borderColor: palette.border,
    },
    fence_code: {
      backgroundColor: palette.background,
    },
    blockquote: {
      backgroundColor: "transparent",
      borderLeftColor: palette.border,
    },
    hr: {
      backgroundColor: palette.border,
    },
    bullet_list_content: listContent,
    ordered_list_content: listContent,
    // A list closes like a paragraph, so the body's -9 cancels its gap too when
    // it ends the bubble instead of eating into the bubble's bottom padding.
    ...(inBubble ? { bullet_list: listGap, ordered_list: listGap } : {}),
  });
}

const listGap = { marginBottom: 9 };

// `flex: 0` cancels the library's default `flex: 1`, which Yoga reads as a zero
// basis even next to `flexBasis: "auto"`. A list that is the widest thing in a
// bubble sizes the bubble, so a zero basis drew its text one letter per line.
const listContent = { flex: 0, flexGrow: 1, flexShrink: 1, minWidth: 0 };

// No `canOpenURL` gate: its answer depends on per-platform scheme query
// declarations and can be false for a link the OS would open, which silently
// swallowed taps. A URL nothing can open just rejects.
function openSafeLink(url: string) {
  const safeUrl = linkHref(url);
  if (safeUrl) Linking.openURL(safeUrl).catch(() => {});
}

// Bare `https://…` and `www.…` in the text become links too, as on web (remark-gfm).
// Fuzzy matching stays off, or every `name.xx` word such as `setup.py` or
// `README.md` would link to an outside domain; `www.` is matched as a prefix.
const markdownit = createMarkdownIt().set({ linkify: true });
let wwwTail: RegExp | undefined;
markdownit.linkify.set({ fuzzyLink: false, fuzzyEmail: false }).add("www.", {
  validate(text: string, pos: number, self: { re: Record<string, string> }) {
    wwwTail ??= new RegExp(`^${self.re.src_host_port_strict}${self.re.src_path}`, "i");
    return text.slice(pos).match(wwwTail)?.[0].length ?? 0;
  },
  normalize(match: { url: string }) {
    match.url = `https://${match.url}`;
  },
});

// Keep links as Text so they stay inside textgroup; Pressable (a View) is laid out
// outside the text flow and collapses the bubble height, overlapping later messages.
const renderRules: RenderRules = {
  link: (node, children, _parent, styleMap) => (
    <Text
      accessibilityRole="link"
      key={node.key}
      style={styleMap.link}
      onPress={() => openSafeLink(node.attributes.href ?? "")}
    >
      {children}
    </Text>
  ),
};

// Untrusted content: drop every image node. The render rule returning null is
// the robust guard (independent of the library's `defaultImageHandler`, which
// defaults to `'https://'` and would otherwise reload a scheme-less URL);
// `allowedImageHandlers: []` + `defaultImageHandler={null}` below back it up.
const renderRulesNoImages: RenderRules = { ...renderRules, image: () => null };

/**
 * Tables render as a `TableGrid` read straight from the markdown tree, so a
 * phone gets compact, content-sized columns instead of the library's cells,
 * which share the width equally and inherit the body's text size. In a
 * bubble the table bleeds to the bubble's edge and its first column lines up
 * with the bubble's text.
 */
/** Room a table takes above and below on top of the paragraph gap, so it
 * does not sit tight against the text around it. */
const TABLE_BLOCK_GAP = 8;

function withTables(base: RenderRules, palette: ColorTokens, bleed: number): RenderRules {
  return {
    ...base,
    table: (node) => (
      <View
        key={node.key}
        style={{
          marginHorizontal: -bleed,
          marginTop: TABLE_BLOCK_GAP,
          marginBottom: 9 + TABLE_BLOCK_GAP,
        }}
      >
        <TableGrid
          table={node as unknown as GridNode}
          palette={palette}
          inset={Math.max(0, bleed - TABLE_CELL_PADDING_X)}
        />
      </View>
    ),
  };
}

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
  allowImages = true,
  palette = darkTokens,
  colorScheme = "dark",
  inBubble = false,
  bleed,
}: ChatMarkdownProps & {
  palette?: ColorTokens;
  colorScheme?: ResolvedAppearance;
  /** Inside a bot bubble (design contract §B "Markdown dans une bulle"): code
   * stays on `background`, tables lose their surface and bleed their
   * hairlines to the bubble's edge. Outside a bubble (a `Surface` card,
   * `FramedBlock`, an artifact preview) this is left at its default, false —
   * their markdown renders exactly as before. */
  inBubble?: boolean;
  /** The host's horizontal padding (a card's): a table bleeds its hairlines
   * to the host's edge and lines its first column up with the host's text.
   * A bubble uses its own 14. */
  bleed?: number;
}) {
  const styles = useMemo(() => markdownStyles(palette, inBubble), [palette, inBubble]);
  const imagePolicy = nativeImagePolicy(allowImages);
  const rules = useMemo(
    () =>
      withTables(
        imagePolicy.blockImages ? renderRulesNoImages : renderRules,
        palette,
        bleed ?? (inBubble ? 14 : 0),
      ),
    [imagePolicy.blockImages, palette, inBubble, bleed],
  );
  const sharedProps = {
    colorScheme,
    style: styles,
    rules,
    allowedImageHandlers: imagePolicy.allowedImageHandlers,
    defaultImageHandler: imagePolicy.defaultImageHandler,
    markdownit,
    onLinkPress: (url: string) => {
      openSafeLink(url);
      return false;
    },
  };

  return (
    <View style={inBubble ? layout.bubbleWrap : layout.wrap}>
      {streaming ? (
        <MarkdownStream {...sharedProps} cursorColor={palette.mutedForeground} streaming>
          {repairMarkdownTables(children)}
        </MarkdownStream>
      ) : (
        <Markdown {...sharedProps}>{repairMarkdownTables(children)}</Markdown>
      )}
    </View>
  );
});

/** Plain text (what the person typed) with every URL in it made clickable. Nest
 * it in a `Text` so links inherit the surrounding ink. A link is its own touch
 * responder, so pass the bubble's `onLongPress` to keep its actions reachable. */
export function LinkifiedText({
  children,
  onLongPress,
}: {
  children: string;
  onLongPress?: TextProps["onLongPress"];
}) {
  return linkifyText(children).map((segment, i) => {
    const href = segment.href;
    return href ? (
      <Text
        accessibilityRole="link"
        key={i}
        style={layout.link}
        onPress={() => openSafeLink(href)}
        onLongPress={onLongPress}
      >
        {segment.text}
      </Text>
    ) : (
      segment.text
    );
  });
}

const layout = StyleSheet.create({
  link: {
    textDecorationLine: "underline",
  },
  wrap: {
    width: "100%",
    minWidth: 0,
    flexShrink: 1,
  },
  bubbleWrap: {
    minWidth: 0,
    flexShrink: 1,
  },
});

export type { ChatMarkdownProps } from "./markdown";
export { hasMarkdownTable, truncateMarkdownForRender } from "./markdown";
export type { GridNode, TableActions } from "./table-grid.native";
export { TableActionsProvider, TableRecords } from "./table-grid.native";
