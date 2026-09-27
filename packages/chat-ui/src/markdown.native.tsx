import { type ColorTokens, darkTokens, type ResolvedAppearance } from "@rakazo/ui-tokens";
import Markdown, {
  createMarkdownIt,
  MarkdownStream,
  type RenderRules,
} from "@ronradtke/react-native-markdown-display";
import { memo, useMemo } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import type { ChatMarkdownProps } from "./markdown";
import { linkHref, linkifyText, nativeImagePolicy } from "./markdown";

function markdownStyles(palette: ColorTokens) {
  return StyleSheet.create({
    body: {
      color: palette.foreground,
      fontSize: 15.5,
      lineHeight: 23,
      width: "100%",
      minWidth: 0,
      flexShrink: 1,
    },
    paragraph: {
      marginTop: 0,
      marginBottom: 9,
      width: "100%",
      flexShrink: 1,
    },
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
    table: {
      borderColor: palette.border,
    },
    tr: {
      borderColor: palette.border,
    },
    hr: {
      backgroundColor: palette.border,
    },
    bullet_list_content: {
      flex: 1,
      flexShrink: 1,
      minWidth: 0,
    },
    ordered_list_content: {
      flex: 1,
      flexShrink: 1,
      minWidth: 0,
    },
  });
}

// No `canOpenURL` gate: its answer depends on per-platform scheme query
// declarations and can be false for a link the OS would open, which silently
// swallowed taps. A URL nothing can open just rejects.
function openSafeLink(url: string) {
  const safeUrl = linkHref(url);
  if (safeUrl) Linking.openURL(safeUrl).catch(() => {});
}

// Bare `https://…` and `www.…` in the text become links too, as on web (remark-gfm).
const markdownit = createMarkdownIt().set({ linkify: true });

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

export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
  allowImages = true,
  palette = darkTokens,
  colorScheme = "dark",
}: ChatMarkdownProps & { palette?: ColorTokens; colorScheme?: ResolvedAppearance }) {
  const styles = useMemo(() => markdownStyles(palette), [palette]);
  const imagePolicy = nativeImagePolicy(allowImages);
  const sharedProps = {
    colorScheme,
    style: styles,
    rules: imagePolicy.blockImages ? renderRulesNoImages : renderRules,
    allowedImageHandlers: imagePolicy.allowedImageHandlers,
    defaultImageHandler: imagePolicy.defaultImageHandler,
    markdownit,
    onLinkPress: (url: string) => {
      openSafeLink(url);
      return false;
    },
  };

  return (
    <View style={layout.wrap}>
      {streaming ? (
        <MarkdownStream {...sharedProps} cursorColor={palette.mutedForeground} streaming>
          {children}
        </MarkdownStream>
      ) : (
        <Markdown {...sharedProps}>{children}</Markdown>
      )}
    </View>
  );
});

/** Plain text (what the person typed) with every URL in it made clickable. Nest
 * it in a `Text` so links inherit the surrounding ink. */
export function LinkifiedText({ children }: { children: string }) {
  return linkifyText(children).map((segment, i) => {
    const href = segment.href;
    return href ? (
      <Text accessibilityRole="link" key={i} style={layout.link} onPress={() => openSafeLink(href)}>
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
});

export type { ChatMarkdownProps } from "./markdown";
export { truncateMarkdownForRender } from "./markdown";
