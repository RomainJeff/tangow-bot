import { StyleSheet } from "react-native";
import { mobileTokens } from "../../lib/appearance";
import { native } from "../../lib/native";
import { nativeTextStyle } from "../../lib/typography";

export function createHomeStyles() {
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
    header: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 16,
      paddingTop: 8,
      paddingBottom: 10,
    },
    headerActions: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    circleButton: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: native.fillPressed,
      alignItems: "center",
      justifyContent: "center",
      overflow: "hidden",
    },
    circlePressed: {
      backgroundColor: native.fill,
    },
    circleAccent: {
      backgroundColor: tokens.primary,
    },
    avatarPressed: {
      opacity: 0.7,
    },
    searchField: {
      marginHorizontal: 16,
      marginBottom: 8,
      minHeight: 44,
      paddingVertical: 10,
      textAlignVertical: "center",
      borderRadius: 10,
      backgroundColor: native.fill,
      color: native.label,
      paddingHorizontal: 12,
      fontSize: 17,
      writingDirection: "auto",
    },
    error: {
      color: native.secondaryLabel,
      paddingHorizontal: 20,
      paddingBottom: 8,
    },
    list: {
      flexGrow: 1,
      paddingBottom: 32,
    },
    empty: {
      color: native.secondaryLabel,
      fontSize: 16,
      paddingHorizontal: 20,
      paddingTop: 28,
    },
    row: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 12,
      gap: 14,
    },
    rowPressed: {
      opacity: 0.55,
    },
    rowBody: {
      flex: 1,
      minWidth: 0,
      gap: 3,
    },
    titleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    // Mobile delta (design contract §1.2): the inbox is the one roster read at
    // arm's length, so `rowName`/`rowStatus` run a few points above the shared
    // sidebar sizes.
    name: {
      flexShrink: 1,
      color: tokens.foreground,
      ...nativeTextStyle("rowName", { size: 18, weight: 500 }),
      writingDirection: "auto",
    },
    nameUnread: {
      fontWeight: "600",
    },
    status: {
      color: tokens.foregroundSubtle,
      ...nativeTextStyle("rowStatus", { size: 15 }),
      writingDirection: "auto",
    },
    time: {
      marginLeft: "auto",
      color: tokens.foregroundSubtle,
      ...nativeTextStyle("time", { size: 13 }),
    },
    unreadDot: {
      width: 7,
      height: 7,
      borderRadius: 3.5,
      backgroundColor: tokens.foreground,
    },
    searchRowTop: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
    },
    searchRowKind: {
      color: native.secondaryLabel,
      fontSize: 13,
    },
    searchRowSnippet: {
      color: native.secondaryLabel,
      fontSize: 14,
      lineHeight: 19,
      writingDirection: "auto",
    },
    spaceHeading: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingTop: 8,
    },
    spaceSelect: {
      flex: 1,
      minHeight: 44,
      justifyContent: "center",
    },
    spaceTitle: {
      color: native.label,
      fontSize: 14,
      fontWeight: "600",
      writingDirection: "auto",
    },
    spaceActions: {
      width: 44,
      height: 44,
      alignItems: "center",
      justifyContent: "center",
    },
    recoveryAction: {
      minHeight: 44,
      paddingHorizontal: 20,
      justifyContent: "center",
    },
    sectionHeading: {
      color: native.secondaryLabel,
      fontSize: 15,
      fontWeight: "600",
      paddingHorizontal: 16,
      paddingTop: 20,
      paddingBottom: 6,
    },
    activitySection: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: native.fillPressed,
      marginBottom: 4,
      paddingBottom: 4,
    },
    activityGap: {
      paddingTop: 16,
    },
    groupAvatar: {
      width: 48,
      height: 48,
      borderRadius: 24,
      backgroundColor: native.fill,
      alignItems: "center",
      justifyContent: "center",
    },
    groupAvatarLabel: {
      color: native.secondaryLabel,
      fontSize: 16,
      fontWeight: "600",
    },
  });
}
