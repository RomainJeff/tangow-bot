import { Stack, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { registerSheetClose, sheetContent } from "../lib/sheet";

/** The native bottom sheet that `openSheet` fills; sized to its content. */
export default function Sheet() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [content] = useState(sheetContent);
  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [router]);

  useEffect(() => registerSheetClose(close), [close]);
  // Reached without content (a stale link or a restored stack): nothing to show.
  useEffect(() => {
    if (!content) close();
  }, [content, close]);

  if (!content) return null;
  return (
    <View style={{ backgroundColor: content.background, paddingBottom: insets.bottom }}>
      <Stack.Screen options={{ contentStyle: { backgroundColor: content.background } }} />
      {content.render(close)}
    </View>
  );
}
