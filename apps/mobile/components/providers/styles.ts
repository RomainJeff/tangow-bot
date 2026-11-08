import { StyleSheet } from "react-native";
import { mobileTokens } from "../../lib/appearance";
import { native } from "../../lib/native";

/** Shared look of the Providers screen and its parts. */
export function createProvidersStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: native.page,
    },
    centered: {
      alignItems: "center",
      justifyContent: "center",
    },
    content: {
      padding: 20,
      gap: 12,
      paddingBottom: 40,
    },
    eyebrow: {
      color: native.tertiaryLabel,
      fontSize: 12,
      textTransform: "uppercase",
      letterSpacing: 1,
    },
    secondary: {
      color: native.secondaryLabel,
      fontSize: 14,
      lineHeight: 20,
      marginTop: 4,
    },
    sectionTitle: {
      color: native.secondaryLabel,
      fontSize: 14,
      marginTop: 8,
      marginBottom: 2,
    },
    card: {
      borderRadius: 14,
      backgroundColor: native.fill,
      overflow: "hidden",
    },
    providerRow: {
      minHeight: 62,
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: native.fillPressed,
    },
    providerCopy: {
      flex: 1,
    },
    providerName: {
      color: native.label,
      fontSize: 16,
      fontWeight: "600",
    },
    connected: {
      color: tokens.success,
      fontSize: 13,
    },
    modelRow: {
      minHeight: 54,
      paddingHorizontal: 16,
      paddingVertical: 10,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: native.fillPressed,
    },
    radio: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 1,
      borderColor: native.secondaryLabel,
      alignItems: "center",
      justifyContent: "center",
    },
    radioDot: {
      width: 10,
      height: 10,
      borderRadius: 5,
      backgroundColor: native.label,
    },
    modelLabel: {
      flex: 1,
      color: native.label,
      fontSize: 15,
    },
    selectedRow: {
      backgroundColor: tokens.accent,
    },
    billing: {
      color: native.secondaryLabel,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 2,
    },
    hint: {
      color: native.secondaryLabel,
      fontSize: 13,
      lineHeight: 19,
      marginTop: 4,
    },
    helpLabel: {
      color: native.secondaryLabel,
      fontSize: 13,
      marginTop: 8,
      textDecorationLine: "underline",
    },
    credentialCard: {
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: native.fillPressed,
      padding: 16,
      marginTop: 8,
    },
    credentialTitle: {
      color: native.label,
      fontSize: 16,
      marginTop: 6,
    },
    oauthCard: {
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: native.fillPressed,
      padding: 16,
      marginTop: 8,
    },
    link: {
      color: native.label,
      fontSize: 14,
      textDecorationLine: "underline",
      marginTop: 6,
    },
    code: {
      color: native.label,
      fontFamily: "monospace",
      fontSize: 24,
      letterSpacing: 3,
      marginTop: 10,
      marginBottom: 2,
    },
    keySection: {
      marginTop: 4,
    },
    keyInput: {
      height: 48,
      borderRadius: 12,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 14,
      marginTop: 4,
      fontSize: 16,
    },
    maxImagesInput: {
      width: 72,
      height: 40,
      marginTop: 0,
      textAlign: "center",
    },
    primaryButton: {
      minHeight: 48,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: native.label,
      marginTop: 12,
      paddingHorizontal: 16,
    },
    primaryLabel: {
      color: native.page,
      fontSize: 16,
      fontWeight: "700",
    },
    outlineButton: {
      minHeight: 48,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: native.fillPressed,
      alignItems: "center",
      justifyContent: "center",
      marginTop: 12,
      paddingHorizontal: 16,
    },
    outlineLabel: {
      color: native.label,
      fontSize: 16,
      fontWeight: "600",
    },
    error: {
      color: tokens.destructive,
      fontSize: 14,
      marginTop: 4,
    },
    notice: {
      color: tokens.success,
      fontSize: 14,
      marginTop: 4,
    },
    disabled: {
      opacity: 0.45,
    },
    pressed: {
      opacity: 0.7,
    },
  });
}
