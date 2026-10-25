import { ASK_DRAFT_SUBJECT_MAX_LENGTH } from "@rakazo/contracts";
import { heldBack, LINE_BREAKS, takeAddresses } from "@rakazo/core";
import { radii, sizes } from "@rakazo/ui-tokens";
import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../lib/native";
import { nativeTextStyle } from "../lib/typography";
import { NativeSymbol } from "./native-symbol";

const REMOVE_ICON = 16;
// The remove glyph is small; the slop grows its target to a 48 pt action.
const REMOVE_SLOP = (sizes.mobileAction - REMOVE_ICON) / 2;

/**
 * One recipient row of the Edit message sheet, like Mail's compose sheet: its label, its addresses
 * as removable items, then a field that takes more until the row is full. A finished word that
 * cannot join the row, not an address or past its room, stays in the field, marked.
 */
export function RecipientRow({
  label,
  addresses,
  typed,
  room,
  onChange,
  onTyped,
  autoFocus,
}: {
  label: string;
  addresses: string[];
  /** The field's text, kept by the sheet so Done can read every row. */
  typed: string;
  /** The most addresses the row takes, or null when any number fits. */
  room: number | null;
  onChange: (addresses: string[]) => void;
  onTyped: (typed: string) => void;
  /** Focus the field on open: a Cc or Bcc row the person just asked for. */
  autoFocus?: boolean;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const styles = useThemedStyles(createStyles);
  const own = useRef<TextInput>(null);
  const [focused, setFocused] = useState(false);
  const full = room !== null && addresses.length >= room;
  const invalid = heldBack(typed);

  function take(value: string, final: boolean) {
    const next = takeAddresses(addresses, value, room, final);
    if (next.addresses.length > addresses.length) onChange(next.addresses);
    onTyped(next.typed);
  }

  return (
    <Pressable accessible={false} onPress={() => own.current?.focus()} style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      {addresses.map((address) => (
        <View key={address} style={styles.address}>
          <Text style={styles.addressText}>{address}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t("Remove {address}", { address })}
            hitSlop={REMOVE_SLOP}
            onPress={() => onChange(addresses.filter((each) => each !== address))}
          >
            <NativeSymbol
              ios="xmark.circle.fill"
              android="close-circle"
              size={REMOVE_ICON}
              color={tokens.mutedForeground}
            />
          </Pressable>
        </View>
      ))}
      {full && !typed && !focused ? null : (
        <TextInput
          ref={own}
          autoFocus={autoFocus}
          accessibilityLabel={label}
          value={typed}
          keyboardType="email-address"
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          submitBehavior="submit"
          onChangeText={(value) => take(value, false)}
          onSubmitEditing={() => take(typed, true)}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            take(typed, true);
          }}
          onKeyPress={(event) => {
            if (event.nativeEvent.key === "Backspace" && !typed && addresses.length) {
              onChange(addresses.slice(0, -1));
            }
          }}
          style={[styles.input, invalid ? styles.invalid : undefined]}
        />
      )}
    </Pressable>
  );
}

/** The row that opens the hidden Cc and Bcc rows, as Mail's "Cc/Bcc" does. */
export function MoreRecipientsRow({ label, onPress }: { label: string; onPress: () => void }) {
  const styles = useThemedStyles(createStyles);
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={styles.row}>
      <Text style={styles.label}>{label}</Text>
    </Pressable>
  );
}

/** The subject row: one line, a pasted line break turned into a space. */
export function SubjectRow({
  label,
  subject,
  onChange,
}: {
  label: string;
  subject: string;
  onChange: (subject: string) => void;
}) {
  const styles = useThemedStyles(createStyles);
  return (
    <View style={styles.row}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        value={subject}
        maxLength={ASK_DRAFT_SUBJECT_MAX_LENGTH}
        submitBehavior="blurAndSubmit"
        onChangeText={(value) => onChange(value.replace(LINE_BREAKS, " "))}
        style={styles.input}
      />
    </View>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    row: {
      flexDirection: "row",
      flexWrap: "wrap",
      alignItems: "center",
      gap: 6,
      minHeight: sizes.mobileAction,
      paddingVertical: 6,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: tokens.border,
    },
    label: { color: tokens.mutedForeground, ...nativeTextStyle("composer") },
    address: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      maxWidth: "100%",
      paddingStart: 10,
      paddingEnd: 6,
      paddingVertical: 4,
      borderRadius: radii.pill,
      backgroundColor: tokens.well,
    },
    addressText: { flexShrink: 1, color: tokens.foreground, ...nativeTextStyle("body") },
    input: {
      flexGrow: 1,
      minWidth: 120,
      paddingVertical: 6,
      color: tokens.foreground,
      ...nativeTextStyle("composer"),
      // A one-line field on iOS draws its text lower when given a line height.
      lineHeight: undefined,
    },
    invalid: {
      color: tokens.destructive,
      textDecorationLine: "underline",
      textDecorationColor: tokens.destructive,
    },
  });
}
