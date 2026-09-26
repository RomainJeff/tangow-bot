import { type ColorTokens, darkTokens, type ResolvedAppearance } from "@rakazo/ui-tokens";
import Markdown, {
  MarkdownStream,
  type RenderRules,
} from "@ronradtke/react-native-markdown-display";
import { memo, useMemo } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import type { ChatMarkdownProps } from "./markdown";
import { nativeImagePolicy, sanitizeMarkdownUrl } from "./markdown";

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

async function openSafeLink(url: string, onInternalLink?: (url: string) => boolean) {
  if (url.startsWith("/") && !url.startsWith("//") && onInternalLink?.(url)) return;
  const safeUrl = sanitizeMarkdownUrl(url);
  if (!safeUrl) return;
  if (await Linking.canOpenURL(safeUrl)) await Linking.openURL(safeUrl);
}

// Keep links as Text so they stay inside textgroup; Pressable (a View) is laid out
// outside the text flow and collapses the bubble height, overlapping later messages.
const renderRules = (onInternalLink?: (url: string) => boolean): RenderRules => ({
  link: (node, children, _parent, styleMap) => (
    <Text
      accessibilityRole="link"
      key={node.key}
      style={styleMap.link}
      onPress={() => {
        void openSafeLink(node.attributes.href ?? "", onInternalLink);
      }}
    >
      {children}
    </Text>
  ),
});

// Untrusted content: drop every image node. The render rule returning null is
// the robust guard (independent of the library's `defaultImageHandler`, which
// defaults to `'https://'` and would otherwise reload a scheme-less URL);
// `allowedImageHandlers: []` + `defaultImageHandler={null}` below back it up.
export const ChatMarkdown = memo(function ChatMarkdown({
  children,
  streaming = false,
  allowImages = true,
  palette = darkTokens,
  colorScheme = "dark",
  onInternalLink,
}: ChatMarkdownProps & {
  palette?: ColorTokens;
  colorScheme?: ResolvedAppearance;
  onInternalLink?: (url: string) => boolean;
}) {
  const styles = useMemo(() => markdownStyles(palette), [palette]);
  const imagePolicy = nativeImagePolicy(allowImages);
  const rules = useMemo(() => {
    const links = renderRules(onInternalLink);
    return allowImages ? links : { ...links, image: () => null };
  }, [allowImages, onInternalLink]);
  const sharedProps = {
    colorScheme,
    style: styles,
    rules,
    allowedImageHandlers: imagePolicy.allowedImageHandlers,
    defaultImageHandler: imagePolicy.defaultImageHandler,
    onLinkPress: (url: string) => {
      void openSafeLink(url, onInternalLink);
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

const layout = StyleSheet.create({
  wrap: {
    width: "100%",
    minWidth: 0,
    flexShrink: 1,
  },
});

export type { ChatMarkdownProps } from "./markdown";
export { truncateMarkdownForRender } from "./markdown";
