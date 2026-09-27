import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { registerSheetClose, sheetContent } from "../lib/sheet";

/** The native bottom sheet that `openSheet` fills; sized to its content. */
export default function Sheet() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [render] = useState(sheetContent);
  const close = useCallback(() => {
    if (router.canGoBack()) router.back();
    else router.replace("/");
  }, [router]);

  useEffect(() => registerSheetClose(close), [close]);
  // Reached without content (a stale link or a restored stack): nothing to show.
  useEffect(() => {
    if (!render) close();
  }, [render, close]);

  if (!render) return null;
  return (
    <View style={{ paddingTop: 24, paddingHorizontal: 16, paddingBottom: insets.bottom + 16 }}>
      {render(close)}
    </View>
  );
}
