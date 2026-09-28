import type { ColorTokens, ResolvedAppearance } from "@rakazo/ui-tokens";
import { darkTokens } from "@rakazo/ui-tokens";
import type { RenderRules } from "@ronradtke/react-native-markdown-display";
import Markdown, {
  createMarkdownIt,
  MarkdownStream,
} from "@ronradtke/react-native-markdown-display";
import { memo, useMemo } from "react";
import type { TextProps } from "react-native";
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
function openSafeLink(url: string, onInternalLink?: (url: string) => boolean) {
  if (url.startsWith("/") && !url.startsWith("//") && onInternalLink?.(url)) return;
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
    markdownit,
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
});

export type { ChatMarkdownProps } from "./markdown";
export { truncateMarkdownForRender } from "./markdown";
