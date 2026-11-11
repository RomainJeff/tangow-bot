import type { AgentSkill, AgentSkillCatalogEntry, SkillAvailability } from "@tangow/contracts";
import { filterSkillList, parseSkillMd } from "@tangow/core";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MobileBot } from "../lib/api";
import { rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

/** Runtime ceiling: the agent only sees the first 50 visible skills. */
const SKILL_LIMIT = 50;

const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when the agent should use it.
---

Steps the agent should follow.
`;

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

export default function Skills() {
  const styles = useThemedStyles(createSkillsStyles);
  const { t } = useI18n();
  const [catalog, setCatalog] = useState<AgentSkillCatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setCatalog(await rpc<AgentSkillCatalogEntry[]>("agentSkills/list"));
  }

  useEffect(() => {
    void refresh().catch((reason: unknown) =>
      setError(errorMessage(reason, t("Could not load skills"))),
    );
  }, []);

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <SkillCatalog
          styles={styles}
          catalog={catalog}
          onChanged={() => void refresh().catch(() => undefined)}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

type Styles = ReturnType<typeof createSkillsStyles>;

/**
 * The space's skill catalog: each skill's reach is disabled, every agent, or a
 * picked set. Tapping a skill opens its SKILL.md in place of the list.
 */
function SkillCatalog({
  styles,
  catalog,
  onChanged,
}: {
  styles: Styles;
  catalog: AgentSkillCatalogEntry[];
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [skills, setSkills] = useState<AgentSkillCatalogEntry[]>(catalog);
  const [bots, setBots] = useState<MobileBot[]>([]);
  const [open, setOpen] = useState<AgentSkill | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [query, setQuery] = useState("");
  /** "all" | "active" | "disabled" | `bot:<id>`. */
  const [filter, setFilter] = useState("all");
  const selection = useRef(0);

  useEffect(() => setSkills(catalog), [catalog]);

  useEffect(() => {
    void rpc<MobileBot[]>("bots/list")
      .then((list) => setBots(list.filter((bot) => !bot.archivedAt)))
      .catch(() => setBots([]));
  }, []);

  async function refresh() {
    try {
      setSkills(await rpc<AgentSkillCatalogEntry[]>("agentSkills/list"));
      onChanged();
    } catch {
      setError(t("Could not load"));
    }
  }

  async function openSkill(entry: AgentSkillCatalogEntry) {
    if (busy) return;
    const current = ++selection.current;
    setCreating(false);
    setConfirmingDelete(false);
    setError(null);
    try {
      const skill = await rpc<AgentSkill>("agentSkills/get", { skillId: entry.id });
      // A slower response must not clobber a newer selection or a fresh draft.
      if (current !== selection.current) return;
      setOpen(skill);
      setDraft(skill.content);
    } catch {
      if (current !== selection.current) return;
      setError(t("Could not load skill"));
    }
  }

  async function setAccess(
    entry: AgentSkillCatalogEntry,
    patch: { availability?: SkillAvailability; bots?: Array<{ botId: string; enabled: boolean }> },
  ) {
    setError(null);
    try {
      const updated = await rpc<AgentSkillCatalogEntry>("agentSkills/setAccess", {
        skillId: entry.id,
        ...patch,
      });
      setSkills((list) => list.map((skill) => (skill.id === updated.id ? updated : skill)));
    } catch {
      setError(t("Could not update agent access"));
    }
  }

  /**
   * Global -> Specific must seed the include list from the bots that can see the skill
   * now; otherwise a lone "excluded" row would flip into being the only include.
   */
  function setAvailability(entry: AgentSkillCatalogEntry, availability: SkillAvailability) {
    if (availability === entry.availability) return;
    void setAccess(entry, {
      availability,
      ...(availability === "selected"
        ? { bots: entry.visibleBotIds.map((id) => ({ botId: id, enabled: true })) }
        : {}),
    });
  }

  async function save() {
    if (busy || !draft.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (creating) await rpc<AgentSkill>("agentSkills/create", { content: draft });
      else if (open)
        await rpc<AgentSkill>("agentSkills/update", { skillId: open.id, content: draft });
      setOpen(null);
      setCreating(false);
      setConfirmingDelete(false);
      await refresh();
    } catch {
      setError(t("Could not save skill"));
    } finally {
      setBusy(false);
    }
  }

  async function importSkill() {
    if (busy) return;
    const picked = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
    const asset = picked.canceled ? undefined : picked.assets[0];
    if (!asset) return;
    setBusy(true);
    setError(null);
    try {
      await rpc<AgentSkill>("agentSkills/import", { data: await new File(asset.uri).base64() });
      await refresh();
    } catch (reason) {
      setError(errorMessage(reason, t("Could not import skill")));
    } finally {
      setBusy(false);
    }
  }

  async function remove(skill: AgentSkill) {
    if (busy) return;
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await rpc("agentSkills/remove", { skillId: skill.id });
      setOpen(null);
      setConfirmingDelete(false);
      await refresh();
    } catch {
      setError(t("Could not delete skill"));
    } finally {
      setBusy(false);
    }
  }

  const availabilityOptions = [
    { value: "disabled", label: t("Disabled") },
    { value: "all", label: t("Global") },
    { value: "selected", label: t("Specific agents") },
  ] satisfies Array<{ value: SkillAvailability; label: string }>;

  const filters = [
    { value: "all", label: t("All") },
    { value: "active", label: t("Active") },
    { value: "disabled", label: t("Disabled") },
    ...bots.map((bot) => ({ value: `bot:${bot.id}`, label: bot.name })),
  ];

  const shown = filterSkillList(skills, { query, filter });
  const editorOpen = creating || open;
  const draftError = (() => {
    if (!editorOpen || open?.readOnly || !draft.trim()) return null;
    const parsed = parseSkillMd(draft);
    return "error" in parsed ? parsed.error : null;
  })();

  if (editorOpen) {
    return (
      <View style={styles.editor}>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {open ? <Text style={styles.title}>{open.name}</Text> : null}
        {open?.source === "shared" ? (
          <View>
            <Text style={styles.secondary}>{open.description}</Text>
            <Text style={styles.secondary}>{t("Content lives on the shared volume.")}</Text>
          </View>
        ) : (
          <TextInput
            value={draft}
            onChangeText={setDraft}
            editable={!open?.readOnly}
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel={t("Skill content")}
            style={styles.textarea}
          />
        )}
        {draftError ? <Text style={styles.error}>{draftError}</Text> : null}
        <View style={styles.actions}>
          {open?.readOnly ? null : (
            <Pressable
              accessibilityRole="button"
              disabled={
                busy ||
                !draft.trim() ||
                Boolean(draftError) ||
                (!creating && draft === open?.content)
              }
              onPress={() => void save()}
              style={styles.smallButton}
            >
              {busy ? (
                <ActivityIndicator color={native.label} />
              ) : (
                <Text style={styles.buttonLabel}>{t("Save")}</Text>
              )}
            </Pressable>
          )}
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              selection.current += 1;
              setOpen(null);
              setCreating(false);
              setConfirmingDelete(false);
            }}
            style={styles.smallButton}
          >
            <Text style={styles.buttonLabel}>{open?.readOnly ? t("Close") : t("Cancel")}</Text>
          </Pressable>
          {open && !open.readOnly ? (
            <Pressable
              accessibilityRole="button"
              disabled={busy}
              onPress={() => void remove(open)}
              style={styles.smallButton}
            >
              <Text style={styles.remove}>
                {confirmingDelete ? t("Confirm delete") : t("Delete")}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {skills.length > SKILL_LIMIT ? (
        <Text style={styles.error}>{t("Only the first 50 skills are shown to the agent.")}</Text>
      ) : null}

      <View style={styles.actions}>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => {
            selection.current += 1;
            setOpen(null);
            setCreating(true);
            setConfirmingDelete(false);
            setDraft(NEW_SKILL_TEMPLATE);
            setError(null);
          }}
          style={styles.smallButton}
        >
          <Text style={styles.buttonLabel}>{t("New skill")}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          testID="skill-import"
          onPress={() => void importSkill()}
          style={styles.smallButton}
        >
          <Text style={styles.buttonLabel}>{t("Import")}</Text>
        </Pressable>
      </View>

      <TextInput
        value={query}
        onChangeText={setQuery}
        accessibilityLabel={t("Search skills")}
        placeholder={t("Search skills")}
        placeholderTextColor={native.tertiaryLabel}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={styles.input}
      />

      {/* ponytail: inline chips; a searchable picker only pays off past ~10 agents. */}
      <View style={styles.chips}>
        {filters.map((entry) => (
          <Chip
            key={entry.value}
            styles={styles}
            label={entry.label}
            on={filter === entry.value}
            onPress={() => setFilter(entry.value)}
          />
        ))}
      </View>

      {shown.length === 0 ? (
        <Text style={styles.secondary}>
          {skills.length === 0 ? t("No skills yet") : t("No skills match")}
        </Text>
      ) : null}

      {shown.map((entry) => {
        // Builtins are always on for every agent; only the rest carry access controls.
        const controlled = entry.source === "user";
        return (
          <View key={entry.id} style={styles.card} testID="skill-row">
            <Pressable accessibilityRole="button" onPress={() => void openSkill(entry)}>
              <View style={styles.row}>
                <View style={styles.grow}>
                  <Text numberOfLines={1} style={styles.title}>
                    {entry.name}
                  </Text>
                  <Text numberOfLines={2} style={styles.secondary}>
                    {entry.description}
                  </Text>
                </View>
                {entry.readOnly ? <Text style={styles.secondary}>{t("read-only")}</Text> : null}
              </View>
            </Pressable>
            {controlled ? (
              <View style={styles.chips}>
                {availabilityOptions.map((option) => (
                  <Chip
                    key={option.value}
                    styles={styles}
                    label={option.label}
                    on={entry.availability === option.value}
                    onPress={() => setAvailability(entry, option.value)}
                  />
                ))}
              </View>
            ) : null}
            {controlled && entry.availability === "selected" ? (
              <View style={styles.chips}>
                {bots.map((bot) => {
                  const visible = entry.visibleBotIds.includes(bot.id);
                  return (
                    <Chip
                      key={bot.id}
                      styles={styles}
                      label={bot.name}
                      on={visible}
                      onPress={() =>
                        void setAccess(entry, { bots: [{ botId: bot.id, enabled: !visible }] })
                      }
                    />
                  );
                })}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function Chip({
  styles,
  label,
  on,
  onPress,
}: {
  styles: Styles;
  label: string;
  on: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      onPress={onPress}
      style={[styles.chip, on && styles.chipOn]}
    >
      <Text style={[styles.chipLabel, on && styles.chipLabelOn]}>{label}</Text>
    </Pressable>
  );
}

function createSkillsStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 14 },
    section: { gap: 12 },
    editor: { gap: 12 },
    actions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
    smallButton: {
      minHeight: 42,
      paddingHorizontal: 14,
      borderRadius: 12,
      backgroundColor: native.fill,
      alignItems: "center",
      justifyContent: "center",
    },
    buttonLabel: { color: native.label, fontSize: 14, fontWeight: "600" },
    card: { padding: 16, borderRadius: 16, backgroundColor: native.fill, gap: 10 },
    input: {
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: native.fillPressed,
      color: native.label,
      paddingHorizontal: 14,
      fontSize: 15,
    },
    textarea: {
      minHeight: 220,
      borderRadius: 12,
      backgroundColor: native.fillPressed,
      color: native.label,
      padding: 14,
      fontSize: 14,
      textAlignVertical: "top",
    },
    row: { flexDirection: "row", alignItems: "center", gap: 10 },
    grow: { flex: 1, gap: 3, minWidth: 0 },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
    chip: {
      minHeight: 32,
      paddingHorizontal: 12,
      borderRadius: 16,
      backgroundColor: native.fillPressed,
      alignItems: "center",
      justifyContent: "center",
    },
    chipOn: { backgroundColor: tokens.primary },
    chipLabel: { color: native.secondaryLabel, fontSize: 13 },
    chipLabelOn: { color: tokens.primaryForeground },
    title: { color: native.label, fontSize: 15, fontWeight: "600" },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
    remove: { color: tokens.destructive, fontSize: 14, fontWeight: "600" },
    error: { color: tokens.destructive, fontSize: 14 },
  });
}
