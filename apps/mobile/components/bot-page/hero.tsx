import { BOT_NAME_MAX_LENGTH, BOT_TITLE_MAX_LENGTH } from "@rakazo/contracts";
import type { FieldSaveState } from "@rakazo/core";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, TextInput, type TextStyle, View } from "react-native";
import { mobileTokens } from "../../lib/appearance";
import { type BotPageContext, type FieldSave, useBotSetting } from "../../lib/bot-page";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens, useThemedStyles } from "../../lib/native";
import { leaveTextField, restingText } from "../../lib/text-field";
import { nativeTextStyle } from "../../lib/typography";
import { BotAvatar } from "../bot-avatar";
import { SaveMeta } from "./kit";

/** The avatar, name and title at the top of the page, each saving on its own. */
export function BotHero({
  page,
  onAppearance,
}: {
  page: BotPageContext;
  onAppearance: () => void;
}) {
  const styles = useThemedStyles(createHeroStyles);
  const { t } = useI18n();
  const { bot, readOnly } = page;
  const name = useBotSetting(page, "name");
  const title = useBotSetting(page, "title");
  const color = useBotSetting(page, "color");
  const shape = useBotSetting(page, "shapeSeed");
  const meta = heroMeta([name, title, color, shape]);

  return (
    <View style={styles.hero}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t("Appearance")}
        disabled={readOnly}
        onPress={onAppearance}
        hitSlop={8}
      >
        <BotAvatar
          color={color.value}
          identity={bot.id}
          shapeSeed={shape.value}
          size={88}
          status={bot.status}
        />
      </Pressable>
      <HeroText
        field={name}
        required
        maxLength={BOT_NAME_MAX_LENGTH}
        label={t("Name")}
        disabled={readOnly}
        style={styles.name}
      />
      <HeroText
        field={title}
        maxLength={BOT_TITLE_MAX_LENGTH}
        label={t("Title")}
        placeholder={t("What it does, in one line")}
        disabled={readOnly}
        style={styles.title}
      />
      <View style={styles.meta}>
        {meta ? <SaveMeta state={meta.state} onRetry={() => void meta.retry()} /> : null}
      </View>
    </View>
  );
}

/** Text edited in place: saved when it loses focus, only when the trimmed text changed. */
function HeroText({
  field,
  required,
  maxLength,
  label,
  placeholder,
  disabled,
  style,
}: {
  field: FieldSave<string>;
  required?: boolean;
  maxLength: number;
  label: string;
  placeholder?: string;
  disabled: boolean;
  style: TextStyle;
}) {
  const tokens = useMobileTokens();
  const resting = restingText(field);
  const [text, setText] = useState(resting);
  const [editing, setEditing] = useState(false);
  useEffect(() => {
    if (!editing) setText(resting);
  }, [editing, resting]);

  const commit = () => {
    setEditing(false);
    leaveTextField(field, text, { required });
  };

  return (
    <TextInput
      accessibilityLabel={label}
      value={text}
      onChangeText={setText}
      onFocus={() => setEditing(true)}
      onBlur={commit}
      editable={!disabled}
      maxLength={maxLength}
      placeholder={placeholder}
      placeholderTextColor={tokens.mutedForeground}
      returnKeyType="done"
      submitBehavior="blurAndSubmit"
      textAlign="center"
      style={style}
    />
  );
}

type HeroField = Pick<FieldSave<unknown>, "state" | "retry">;

/** The hero shares one meta line: a failure first, then a save in flight, then the latest save. */
function heroMeta(fields: HeroField[]): HeroField | undefined {
  const savedAt = (state: FieldSaveState<unknown>) => (state.kind === "saved" ? state.at : 0);
  return (
    fields.find((field) => field.state.kind === "failed") ??
    fields.find((field) => field.state.kind === "saving") ??
    fields
      .filter((field) => field.state.kind === "saved")
      .sort((a, b) => savedAt(b.state) - savedAt(a.state))[0]
  );
}

function createHeroStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    hero: { alignItems: "center", paddingTop: 12, paddingHorizontal: 20 },
    name: {
      alignSelf: "stretch",
      marginTop: 16,
      paddingVertical: 2,
      color: tokens.foreground,
      ...nativeTextStyle("title", { size: 22, weight: 600 }),
    },
    title: {
      alignSelf: "stretch",
      marginTop: 2,
      paddingVertical: 2,
      color: tokens.mutedForeground,
      ...nativeTextStyle("meta", { size: 15 }),
    },
    meta: { minHeight: 18, marginTop: 6, alignItems: "center" },
  });
}
