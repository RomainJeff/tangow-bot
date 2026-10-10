import type {
  AgentSkill,
  AgentSkillCatalogEntry,
  MarketplaceFileChange,
  MarketplacePlugin,
  MarketplaceUpdateCheck,
  SkillAvailability,
  SpaceMarketplace,
} from "@rakazo/contracts";
import { filterSkillList, marketplaceSkillKey, parseSkillMd } from "@rakazo/core";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { type MobileBot, rpc } from "../lib/api";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";

/** Runtime ceiling: the agent only sees the first 50 visible skills. */
const SKILL_LIMIT = 50;

/** Pending key for the batch install; not a valid plugin name, so it cannot collide with one. */
const BATCH = "\0batch";

/** Cloning and diffing a marketplace repository outlives the default RPC timeout. */
const GIT_RPC = { timeoutMs: 60_000 } as const;

const NEW_SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does and when the agent should use it.
---

Steps the agent should follow.
`;

type SkillsTab = "installed" | "marketplaces" | "browse";

function errorMessage(reason: unknown, fallback: string) {
  return reason instanceof Error && reason.message ? reason.message : fallback;
}

/**
 * Space-level skills panel, the mobile twin of the web Skills overlay: the skill
 * catalog (Installed), GitHub marketplaces (Marketplaces) and their plugins (Browse).
 */
export default function Skills() {
  const styles = useThemedStyles(createSkillsStyles);
  const { t } = useI18n();
  const [tab, setTab] = useState<SkillsTab>("installed");
  const [catalog, setCatalog] = useState<AgentSkillCatalogEntry[]>([]);
  const [marketplaces, setMarketplaces] = useState<SpaceMarketplace[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    const [skills, spaces] = await Promise.all([
      rpc<AgentSkillCatalogEntry[]>("agentSkills/list"),
      rpc<SpaceMarketplace[]>("marketplaces/list", {}),
    ]);
    setCatalog(skills);
    setMarketplaces(spaces);
  }

  // ponytail: refetch on every tab switch so the counter follows edits made in Installed.
  useEffect(() => {
    void refresh().catch((reason: unknown) =>
      setError(errorMessage(reason, t("Could not load skills"))),
    );
  }, [tab]);

  const tabs = [
    { id: "installed" as const, label: t("Installed") },
    { id: "marketplaces" as const, label: t("Marketplaces") },
    { id: "browse" as const, label: t("Browse") },
  ];

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        <View style={styles.tabs}>
          {tabs.map((entry) => (
            <Pressable
              key={entry.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === entry.id }}
              testID={`skills-tab-${entry.id}`}
              onPress={() => setTab(entry.id)}
              style={[styles.tab, tab === entry.id && styles.tabOn]}
            >
              <Text style={[styles.tabLabel, tab === entry.id && styles.tabLabelOn]}>
                {entry.label}
              </Text>
            </Pressable>
          ))}
        </View>

        {error ? <Text style={styles.error}>{error}</Text> : null}

        {tab === "installed" ? (
          <InstalledTab
            styles={styles}
            catalog={catalog}
            onChanged={() => void refresh().catch(() => undefined)}
          />
        ) : null}

        {tab === "marketplaces" ? (
          <MarketplacesTab
            styles={styles}
            marketplaces={marketplaces}
            onChanged={refresh}
            onError={setError}
          />
        ) : null}

        {tab === "browse" ? (
          <BrowseTab
            styles={styles}
            marketplaces={marketplaces}
            catalog={catalog}
            onChanged={refresh}
            onError={setError}
          />
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

type Styles = ReturnType<typeof createSkillsStyles>;

/**
 * The space's skill catalog: each skill's reach is disabled, every agent, or a
 * picked set. Tapping a skill opens its SKILL.md in place of the list.
 */
function InstalledTab({
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
        const controlled = entry.source !== "builtin";
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

function MarketplacesTab({
  styles,
  marketplaces,
  onChanged,
  onError,
}: {
  styles: Styles;
  marketplaces: SpaceMarketplace[];
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const { t } = useI18n();
  const [url, setUrl] = useState("");
  const [ref, setRef] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, MarketplaceUpdateCheck>>({});

  async function run(key: string, fallback: string, action: () => Promise<void>) {
    setPending(key);
    onError(null);
    try {
      await action();
    } catch (reason) {
      onError(errorMessage(reason, fallback));
    } finally {
      setPending(null);
    }
  }

  return (
    <View style={styles.section}>
      <TextInput
        value={url}
        onChangeText={setUrl}
        accessibilityLabel={t("Marketplace URL")}
        placeholder="https://github.com/owner/repo"
        placeholderTextColor={native.tertiaryLabel}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <TextInput
        value={ref}
        onChangeText={setRef}
        accessibilityLabel={t("Git ref")}
        placeholder="HEAD"
        placeholderTextColor={native.tertiaryLabel}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <Pressable
        accessibilityRole="button"
        disabled={pending === "add" || !url.trim()}
        onPress={() =>
          void run("add", t("Could not add marketplace"), async () => {
            await rpc<SpaceMarketplace>(
              "marketplaces/add",
              { url: url.trim(), ref: ref.trim() || undefined },
              GIT_RPC,
            );
            setUrl("");
            setRef("");
            await onChanged();
          })
        }
        style={styles.smallButton}
      >
        <Text style={styles.buttonLabel}>
          {pending === "add" ? t("Adding…") : t("Add marketplace")}
        </Text>
      </Pressable>
      <Text style={styles.secondary}>
        {t(
          "A plugin marketplace (.claude-plugin/marketplace.json) or a repository of skills (SKILL.md files). The format is detected automatically.",
        )}
      </Text>

      {marketplaces.length === 0 ? (
        <Text style={styles.secondary}>{t("No marketplaces added yet.")}</Text>
      ) : null}

      {marketplaces.map((mkt) => {
        const check = checks[mkt.id];
        return (
          <View key={mkt.id} style={styles.card}>
            <View style={styles.row}>
              <View style={styles.grow}>
                <Text style={styles.title}>{mkt.name}</Text>
                <Text style={styles.badge}>
                  {mkt.kind === "skills" ? t("Skills") : t("Plugins")}
                </Text>
              </View>
            </View>
            <Text numberOfLines={2} style={styles.secondary}>
              {mkt.url} · {mkt.ref} @ {mkt.commit.slice(0, 7)} ·{" "}
              {mkt.kind === "skills"
                ? t("{count} skills installed", { count: mkt.installedPlugins.length })
                : t("{count} plugins installed", { count: mkt.installedPlugins.length })}
            </Text>
            <View style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                disabled={pending === `check:${mkt.id}`}
                onPress={() =>
                  void run(`check:${mkt.id}`, t("Could not check for updates"), async () => {
                    const result = await rpc<MarketplaceUpdateCheck>(
                      "marketplaces/checkUpdate",
                      { marketplaceId: mkt.id },
                      GIT_RPC,
                    );
                    setChecks((prev) => ({ ...prev, [mkt.id]: result }));
                  })
                }
                style={styles.smallButton}
              >
                <Text style={styles.buttonLabel}>
                  {pending === `check:${mkt.id}` ? t("Checking…") : t("Check update")}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                disabled={pending === `remove:${mkt.id}`}
                onPress={() =>
                  Alert.alert(
                    t("Remove marketplace {name} and its skills?", { name: mkt.name }),
                    undefined,
                    [
                      { text: t("Cancel"), style: "cancel" },
                      {
                        text: t("Remove"),
                        style: "destructive",
                        onPress: () =>
                          void run(
                            `remove:${mkt.id}`,
                            t("Could not remove marketplace"),
                            async () => {
                              await rpc("marketplaces/remove", { marketplaceId: mkt.id }, GIT_RPC);
                              await onChanged();
                            },
                          ),
                      },
                    ],
                  )
                }
                style={styles.smallButton}
              >
                <Text style={styles.remove}>
                  {pending === `remove:${mkt.id}` ? t("Removing…") : t("Remove")}
                </Text>
              </Pressable>
            </View>

            {check?.upToDate ? <Text style={styles.secondary}>{t("Up to date.")}</Text> : null}
            {check && !check.upToDate ? (
              <>
                {check.changes.map((change) => (
                  <FileChange key={change.path} styles={styles} change={change} />
                ))}
                <Pressable
                  accessibilityRole="button"
                  disabled={pending === `apply:${mkt.id}`}
                  onPress={() =>
                    void run(`apply:${mkt.id}`, t("Could not apply update"), async () => {
                      await rpc<SpaceMarketplace>(
                        "marketplaces/applyUpdate",
                        { marketplaceId: mkt.id, commit: check.commit },
                        GIT_RPC,
                      );
                      setChecks(({ [mkt.id]: _applied, ...rest }) => rest);
                      await onChanged();
                    })
                  }
                  style={styles.smallButton}
                >
                  <Text style={styles.buttonLabel}>
                    {pending === `apply:${mkt.id}`
                      ? t("Applying…")
                      : t("Apply update to {commit}", { commit: check.commit.slice(0, 7) })}
                  </Text>
                </Pressable>
              </>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function FileChange({ styles, change }: { styles: Styles; change: MarketplaceFileChange }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const diffable =
    change.status === "modified" && change.before !== undefined && change.after !== undefined;
  return (
    <View>
      <Pressable
        accessibilityRole={diffable ? "button" : "text"}
        accessibilityState={diffable ? { expanded: open } : undefined}
        disabled={!diffable}
        onPress={() => setOpen((value) => !value)}
      >
        {/* ponytail: no byte sizes here; the web helper is lingui-bound and the numbers are decoration. */}
        <Text numberOfLines={1} style={styles.secondary}>
          <Text style={styles[change.status]}>{change.status}</Text> {change.path}
        </Text>
        {diffable ? (
          <Text style={styles.secondary}>
            {open ? t("Hide before / after") : t("Show before / after")}
          </Text>
        ) : null}
      </Pressable>
      {/* ponytail: before then after instead of a diff lib. */}
      {diffable && open ? (
        <View style={styles.diff}>
          <Text style={styles.code}>{change.before}</Text>
          <Text style={styles.code}>{change.after}</Text>
        </View>
      ) : null}
    </View>
  );
}

function BrowseTab({
  styles,
  marketplaces,
  catalog,
  onChanged,
  onError,
}: {
  styles: Styles;
  marketplaces: SpaceMarketplace[];
  catalog: AgentSkillCatalogEntry[];
  onChanged: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const { t } = useI18n();
  const [selectedId, setSelectedId] = useState("");
  const [plugins, setPlugins] = useState<MarketplacePlugin[]>([]);
  const [pending, setPending] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const marketplaceId = marketplaces.some((mkt) => mkt.id === selectedId)
    ? selectedId
    : (marketplaces[0]?.id ?? "");
  const marketplace = marketplaces.find((mkt) => mkt.id === marketplaceId);

  async function loadPlugins() {
    if (!marketplaceId) {
      setPicked(new Set());
      return setPlugins([]);
    }
    const next = await rpc<MarketplacePlugin[]>("marketplaces/plugins", { marketplaceId }, GIT_RPC);
    setPlugins(next);
    // ponytail: prune instead of clear, so a single-row install/remove keeps the other ticks.
    const selectable = new Set(next.filter((p) => !p.installed && p.supported).map((p) => p.name));
    setPicked((prev) => new Set([...prev].filter((name) => selectable.has(name))));
  }

  useEffect(() => {
    // Another marketplace can list the same plugin name: prune alone would keep the tick.
    setPicked(new Set());
    void loadPlugins().catch((reason: unknown) =>
      onError(errorMessage(reason, t("Could not load plugins"))),
    );
  }, [marketplaceId]);

  async function run(key: string, fallback: string, action: () => Promise<void>) {
    setPending(key);
    onError(null);
    try {
      await action();
      await Promise.all([onChanged(), loadPlugins()]);
    } catch (reason) {
      onError(errorMessage(reason, fallback));
    } finally {
      setPending(null);
    }
  }

  // ponytail: two install paths in the UI, one on the server (installPlugin = installPlugins([p])).
  function toggle(plugin: MarketplacePlugin) {
    if (!marketplace) return;
    void run(plugin.name, t("Could not update plugin"), async () => {
      const input = { marketplaceId: marketplace.id, plugin: plugin.name };
      await rpc(
        plugin.installed ? "marketplaces/removePlugin" : "marketplaces/installPlugin",
        input,
        GIT_RPC,
      );
    });
  }

  if (marketplaces.length === 0) {
    return <Text style={styles.secondary}>{t("Add a marketplace first.")}</Text>;
  }

  return (
    <View style={styles.section}>
      <View style={styles.chips}>
        {marketplaces.map((mkt) => (
          <Chip
            key={mkt.id}
            styles={styles}
            label={mkt.name}
            on={mkt.id === marketplaceId}
            onPress={() => setSelectedId(mkt.id)}
          />
        ))}
      </View>

      {picked.size > 0 ? (
        <View style={styles.row}>
          <Text style={[styles.secondary, styles.grow]}>
            {t("{count} selected", { count: picked.size })}
          </Text>
          <Pressable
            accessibilityRole="button"
            disabled={pending !== null}
            onPress={() =>
              void run(BATCH, t("Could not install skills"), async () => {
                if (!marketplace) return;
                await rpc(
                  "marketplaces/installPlugins",
                  { marketplaceId: marketplace.id, plugins: [...picked] },
                  GIT_RPC,
                );
              })
            }
            style={styles.smallButton}
          >
            <Text style={styles.buttonLabel}>
              {pending === BATCH
                ? t("Installing…")
                : t("Install selected ({count})", { count: picked.size })}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {plugins.length === 0 ? (
        <Text style={styles.secondary}>
          {marketplace?.kind === "skills"
            ? t("No skills in this marketplace.")
            : t("No plugins in this marketplace.")}
        </Text>
      ) : null}

      {plugins.map((plugin) => {
        const prefix = marketplace ? marketplaceSkillKey(marketplace.name, plugin.name, "") : "";
        const skills = plugin.installed ? catalog.filter((s) => s.id.startsWith(prefix)) : [];
        const selectable = !plugin.installed && plugin.supported;
        return (
          <View key={plugin.name} style={styles.card}>
            <View style={styles.row}>
              {selectable ? (
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityLabel={t("Select {name}", { name: plugin.name })}
                  accessibilityState={{ checked: picked.has(plugin.name) }}
                  onPress={() =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (next.has(plugin.name)) next.delete(plugin.name);
                      else next.add(plugin.name);
                      return next;
                    })
                  }
                  style={[styles.checkbox, picked.has(plugin.name) && styles.checkboxOn]}
                >
                  <Text style={styles.checkmark}>{picked.has(plugin.name) ? "✓" : ""}</Text>
                </Pressable>
              ) : null}
              <View style={styles.grow}>
                <Text style={styles.title}>{plugin.name}</Text>
                {plugin.supported ? null : (
                  <Text style={styles.badge}>{t("Unsupported source")}</Text>
                )}
                {plugin.description ? (
                  <Text numberOfLines={3} style={styles.secondary}>
                    {plugin.description}
                  </Text>
                ) : null}
              </View>
              <Pressable
                accessibilityRole="button"
                disabled={pending !== null || (!plugin.supported && !plugin.installed)}
                onPress={() => toggle(plugin)}
              >
                <Text style={plugin.installed ? styles.remove : styles.link}>
                  {pending === plugin.name
                    ? t("Working…")
                    : plugin.installed
                      ? t("Remove")
                      : t("Install")}
                </Text>
              </Pressable>
            </View>
            {plugin.installed ? (
              <>
                {/* One plugin is one skill in a skills repository, so the sublist adds nothing. */}
                {marketplace?.kind !== "skills" && skills.length === 0 ? (
                  <Text style={styles.secondary}>{t("No skills in this plugin.")}</Text>
                ) : null}
                {marketplace?.kind !== "skills"
                  ? skills.map((skill) => (
                      <Text key={skill.id} numberOfLines={2} style={styles.secondary}>
                        {skill.name}
                        {skill.description ? ` — ${skill.description}` : ""}
                      </Text>
                    ))
                  : null}
                <Text style={styles.secondary}>
                  {t("Off for every agent until you pick some in Installed.")}
                </Text>
              </>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

function createSkillsStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 20, gap: 14 },
    section: { gap: 12 },
    editor: { gap: 12 },
    tabs: { flexDirection: "row", gap: 8 },
    tab: {
      flex: 1,
      minHeight: 42,
      borderRadius: 12,
      backgroundColor: native.fill,
      alignItems: "center",
      justifyContent: "center",
    },
    tabOn: { backgroundColor: native.fillPressed },
    tabLabel: { color: native.secondaryLabel, fontSize: 14, fontWeight: "600" },
    tabLabelOn: { color: native.label },
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
    checkbox: {
      width: 26,
      height: 26,
      borderRadius: 8,
      backgroundColor: native.fillPressed,
      alignItems: "center",
      justifyContent: "center",
    },
    checkboxOn: { backgroundColor: tokens.primary },
    checkmark: { color: tokens.primaryForeground, fontSize: 15, fontWeight: "600" },
    title: { color: native.label, fontSize: 15, fontWeight: "600" },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
    badge: { color: native.tertiaryLabel, fontSize: 12, fontWeight: "600" },
    link: { color: native.label, fontSize: 14, fontWeight: "600" },
    remove: { color: tokens.destructive, fontSize: 14, fontWeight: "600" },
    error: { color: tokens.destructive, fontSize: 14 },
    added: { color: tokens.success },
    removed: { color: tokens.destructive },
    modified: { color: tokens.warning },
    diff: { gap: 8, marginTop: 6 },
    code: {
      color: native.label,
      backgroundColor: native.fillPressed,
      borderRadius: 8,
      padding: 8,
      fontSize: 12,
      fontFamily: "Menlo",
    },
  });
}
