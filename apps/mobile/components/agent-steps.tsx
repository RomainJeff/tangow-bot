import type { MessageBlock } from "@rakazo/contracts";
import { useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

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
 * "Steps (n)" toggle above a message, listing the tools the bot used; each name
 * opens its own sheet with that call's input and output. Web counterpart:
 * apps/web/src/components/AgentSteps.tsx.
 */
export function AgentSteps({ block }: { block: StepsBlock }) {
  const { t } = useI18n();
  const styles = useThemedStyles(createAgentStepsStyles);
  const [expanded, setExpanded] = useState(false);
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const calls = stepCalls(block);
  if (calls.length === 0) return null;
  const openCall = openIndex === null ? undefined : calls[openIndex];
  const toggleLabel = t("Steps ({count})", { count: calls.length });
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
              <Text style={styles.callName}>{call.name}</Text>
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
    container: { alignItems: "flex-start", gap: 4 },
    toggle: {
      borderWidth: 1,
      borderColor: tokens.border,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 5,
    },
    toggleLabel: { color: native.secondaryLabel, fontSize: 12.5 },
    pressed: { opacity: 0.6 },
    callList: { alignItems: "flex-start", gap: 2, paddingLeft: 4 },
    call: { paddingHorizontal: 8, paddingVertical: 3 },
    callName: { color: native.secondaryLabel, fontSize: 12.5 },
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
    detail: { color: native.secondaryLabel, fontSize: 12.5 },
    payload: { gap: 4 },
    payloadBox: { backgroundColor: tokens.muted, borderRadius: 12, padding: 12 },
    payloadText: { color: native.label, fontSize: 12.5, lineHeight: 19 },
  });
}
