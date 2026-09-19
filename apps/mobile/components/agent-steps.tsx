import type { MessageBlock } from "@rakazo/contracts";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance";
import { formatShortDuration } from "../lib/format-elapsed";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens, useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { NativeSymbol } from "./native-symbol";
import { ShimmerText } from "./shimmer-text";

type StepsBlock = Extract<MessageBlock, { kind: "steps" }>;
type StepCall = { name: string; input: string; output: string };

/** Flattens collapsed steps back to one entry per call, detail-free calls included. */
export function stepCalls(block: StepsBlock): StepCall[] {
  return block.steps.flatMap((step) =>
    step.calls?.length
      ? step.calls
      : Array.from({ length: step.count }, () => ({ name: step.label, input: "", output: "" })),
  );
}

/**
 * What the bot thought, folded away until someone asks: "Thought for 41s · 4
 * steps" over the tools it used, each name opening its own sheet with that
 * call's input and output. The native counterpart of `ReasoningDisclosure`;
 * web counterpart: apps/web/src/components/AgentSteps.tsx.
 */
export function AgentSteps({ block, live = false }: { block: StepsBlock; live?: boolean }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createAgentStepsStyles);
  const tokens = useMobileTokens();
  const [expanded, setExpanded] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const calls = stepCalls(block);
  if (calls.length === 0) return null;
  const openCall = openIndex === null ? undefined : calls[openIndex];
  const stepsLabel = calls.length === 1 ? t("1 step") : t("{count} steps", { count: calls.length });
  const toggleLabel =
    block.durationMs === undefined
      ? stepsLabel
      : t("Thought for {duration} · {steps}", {
          duration: formatShortDuration(block.durationMs),
          steps: stepsLabel,
        });
  const lastIndex = calls.length - 1;
  return (
    <View style={styles.container}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={toggleLabel}
        accessibilityState={{ expanded }}
        hitSlop={8}
        onPress={() => setExpanded((open) => !open)}
        style={({ pressed }) => [styles.toggle, pressed && styles.pressed]}
      >
        <NativeSymbol
          ios={expanded ? "chevron.down" : "chevron.right"}
          android={expanded ? "chevron-down-outline" : "chevron-forward-outline"}
          size={12}
          color={tokens.mutedForeground}
        />
        <Text style={styles.toggleLabel}>{toggleLabel}</Text>
      </Pressable>
      {expanded ? (
        <View style={styles.callList}>
          {calls.map((call, index) => (
            <Pressable
              key={`${call.name}-${index}`}
              accessibilityRole="button"
              accessibilityLabel={call.name}
              hitSlop={8}
              onPress={() => setOpenIndex(index)}
              style={({ pressed }) => [styles.call, pressed && styles.pressed]}
            >
              {live && index === lastIndex ? (
                <ShimmerText style={styles.callName}>{call.name}</ShimmerText>
              ) : (
                <Text style={styles.callName}>{call.name}</Text>
              )}
            </Pressable>
          ))}
        </View>
      ) : null}
      {openCall ? (
        <Modal
          animationType="slide"
          presentationStyle="pageSheet"
          onRequestClose={() => setOpenIndex(null)}
        >
          <SafeAreaView style={styles.sheet}>
            <View style={styles.sheetHeader}>
              <Text numberOfLines={1} style={styles.sheetTitle}>
                {openCall.name}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t("Close")}
                hitSlop={8}
                onPress={() => setOpenIndex(null)}
              >
                <Text style={styles.close}>{t("Close")}</Text>
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.sheetBody}>
              {openCall.input || openCall.output ? (
                <>
                  <StepPayload label={t("Input")} value={openCall.input} styles={styles} />
                  <StepPayload label={t("Output")} value={openCall.output} styles={styles} />
                </>
              ) : (
                <Text style={styles.detail}>
                  {t("This call ran before step details were recorded.")}
                </Text>
              )}
            </ScrollView>
          </SafeAreaView>
        </Modal>
      ) : null}
    </View>
  );
}

function StepPayload({
  label,
  value,
  styles,
}: {
  label: string;
  value: string;
  styles: ReturnType<typeof createAgentStepsStyles>;
}) {
  const { t } = useI18n();
  return (
    <View style={styles.payload}>
      <Text style={styles.detail}>{label}</Text>
      <View style={styles.payloadBox}>
        <Text selectable style={styles.payloadText}>
          {value || t("(empty)")}
        </Text>
      </View>
    </View>
  );
}

function createAgentStepsStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    container: { alignItems: "flex-start", gap: 6 },
    toggle: { flexDirection: "row", alignItems: "center", gap: 6 },
    toggleLabel: { color: tokens.mutedForeground, ...nativeTextStyle("reasoning") },
    pressed: { opacity: 0.6 },
    // The rail the web draws with `border-s-2`, in a logical property so RTL
    // puts it on the other side.
    callList: {
      alignItems: "flex-start",
      gap: 4,
      borderStartWidth: 2,
      borderStartColor: tokens.border,
      paddingStart: 12,
    },
    call: { paddingVertical: 2 },
    callName: { color: tokens.mutedForeground, ...nativeTextStyle("reasoning") },
    sheet: { flex: 1, backgroundColor: native.page },
    sheetHeader: {
      height: 54,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderBottomWidth: 1,
      borderBottomColor: tokens.border,
      paddingHorizontal: 16,
    },
    sheetTitle: { flex: 1, color: native.label, fontSize: 15, fontWeight: "500" },
    close: { color: native.secondaryLabel, fontSize: 14 },
    sheetBody: { padding: 16, gap: 12 },
    detail: { color: tokens.mutedForeground, ...nativeTextStyle("meta") },
    payload: { gap: 4 },
    payloadBox: { backgroundColor: tokens.muted, borderRadius: 12, padding: 12 },
    payloadText: { color: native.label, fontSize: 12.5, lineHeight: 19 },
  });
}
