import {
  GROUP_DESCRIPTION_MAX_LENGTH,
  GROUP_MEMBER_MAX,
  GROUP_MEMBER_MIN,
} from "@rakazo/contracts";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput } from "react-native";
import { BotAvatar } from "../components/bot-avatar";
import { BotMemberPicker, PersonPicker, useSpacePeople } from "../components/bot-member-picker";
import { NativeMenu } from "../components/native-menu";
import { NativeSymbol } from "../components/native-symbol";
import { type MobileBot, type MobileGroup, rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { serverMessage } from "../lib/server-error";

export default function GroupSettingsScreen() {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const router = useRouter();
  const { groupId } = useLocalSearchParams<{ groupId: string }>();
  const [group, setGroup] = useState<MobileGroup | null>(null);
  const [bots, setBots] = useState<MobileBot[]>([]);
  const people = useSpacePeople();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [leadBotId, setLeadBotId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!groupId) return;
    void Promise.all([
      rpc<MobileGroup[]>("groups/list").then(
        (groups) => groups.find((row) => row.id === groupId) ?? null,
      ),
      rpc<MobileBot[]>("bots/list"),
    ])
      .then(([nextGroup, nextBots]) => {
        if (!nextGroup) throw new Error(t("Group not found"));
        setGroup(nextGroup);
        setName(nextGroup.name);
        setDescription(nextGroup.description ?? "");
        setSelected(nextGroup.members.map((member) => member.botId));
        // Its creator comes first and is always in it.
        setUserIds(nextGroup.people.slice(1).map((person) => person.userId));
        setLeadBotId(nextGroup.leadBotId);
        setBots(nextBots.filter((bot) => !bot.archivedAt));
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("Could not load group")));
  }, [groupId]);

  // A lead that left the group gives way to its first bot, as the server does.
  const lead = leadBotId && selected.includes(leadBotId) ? leadBotId : selected[0];
  const leadBot = bots.find((bot) => bot.id === lead);

  async function save() {
    if (!groupId || !group || pending) return;
    setPending(true);
    setError(null);
    try {
      const input: {
        groupId: string;
        name?: string;
        description?: string;
        botIds?: string[];
        userIds?: string[];
        leadBotId?: string;
      } = { groupId };
      if (name.trim() !== group.name) input.name = name.trim();
      if (description.trim() !== (group.description ?? "")) input.description = description.trim();
      const memberIds = group.members.map((member) => member.botId).join(",");
      if (selected.join(",") !== memberIds) input.botIds = selected;
      const peopleIds = group.people.slice(1).map((person) => person.userId);
      if ([...userIds].sort().join(",") !== [...peopleIds].sort().join(","))
        input.userIds = userIds;
      if (leadBotId && leadBotId !== group.leadBotId && selected.includes(leadBotId))
        input.leadBotId = leadBotId;
      if (Object.keys(input).length > 1) await rpc("groups/update", input);
      router.back();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("Could not save group"));
    } finally {
      setPending(false);
    }
  }

  function remove() {
    if (!groupId || !group) return;
    Alert.alert(group.name, t("Delete this group? Bots and their solo threads are kept."), [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Delete"),
        style: "destructive",
        onPress: () =>
          void rpc("groups/remove", { groupId })
            .then(() => router.replace("/"))
            .catch((err) =>
              Alert.alert(
                t("Could not delete group"),
                err instanceof Error ? err.message : t("Try again."),
              ),
            ),
      },
    ]);
  }

  function leave() {
    if (!groupId || !group) return;
    Alert.alert(group.name, undefined, [
      { text: t("Cancel"), style: "cancel" },
      {
        text: t("Leave group"),
        style: "destructive",
        onPress: () =>
          void rpc("groups/leave", { groupId })
            .then(() => router.replace("/"))
            .catch((err) => setError(serverMessage(err) || t("Try again."))),
      },
    ]);
  }

  const label = { color: tokens.mutedForeground, fontSize: 14, marginTop: 20 };
  const field = {
    marginTop: 8,
    backgroundColor: tokens.muted,
    borderRadius: 11,
    padding: 14,
    color: tokens.foreground,
    fontSize: 16,
  };

  // Only its creator changes a group; everyone else sees who is in it and may leave.
  if (group && !group.canManage) {
    return (
      <>
        <Stack.Screen options={{ title: t("Group settings") }} />
        <ScrollView
          testID="group-settings"
          style={{ flex: 1, backgroundColor: tokens.background }}
          contentContainerStyle={{ padding: 24 }}
        >
          <Text style={{ color: tokens.foreground, fontSize: 20, fontWeight: "600" }}>
            {group.name}
          </Text>
          {group.description ? (
            <Text style={{ color: tokens.mutedForeground, fontSize: 16, marginTop: 6 }}>
              {group.description}
            </Text>
          ) : null}
          <Text style={label}>{t("People")}</Text>
          <PersonPicker people={group.people} />
          <Text style={label}>{t("Bots")}</Text>
          <BotMemberPicker
            bots={group.members.map((member) => ({ ...member, id: member.botId }))}
          />
          {error ? <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text> : null}
          <Pressable
            onPress={leave}
            style={{
              marginTop: 24,
              borderRadius: 11,
              borderWidth: 1,
              borderColor: tokens.border,
              padding: 14,
              alignItems: "center",
            }}
          >
            <Text style={{ color: tokens.destructive, fontSize: 16 }}>{t("Leave group")}</Text>
          </Pressable>
        </ScrollView>
      </>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: t("Group settings") }} />
      <ScrollView
        testID="group-settings"
        style={{ flex: 1, backgroundColor: tokens.background }}
        contentContainerStyle={{ padding: 24 }}
      >
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>{t("Name")}</Text>
        <TextInput
          value={name}
          onChangeText={setName}
          placeholder={t("Group name")}
          placeholderTextColor={tokens.mutedForeground}
          style={field}
        />
        <Text style={label}>{t("Description")}</Text>
        <TextInput
          value={description}
          maxLength={GROUP_DESCRIPTION_MAX_LENGTH}
          onChangeText={setDescription}
          placeholder={t("What this group is for")}
          placeholderTextColor={tokens.mutedForeground}
          multiline
          style={{ ...field, minHeight: 96, textAlignVertical: "top" }}
        />
        {people.length > 0 ? (
          <>
            <Text style={label}>{t("People")}</Text>
            <PersonPicker
              people={people}
              selected={userIds}
              onChange={setUserIds}
              disabled={pending}
            />
          </>
        ) : null}
        <Text style={label}>{t("Bots")}</Text>
        <BotMemberPicker
          bots={bots}
          selected={selected}
          onChange={setSelected}
          disabled={pending}
        />
        {selected.length > 1 && lead ? (
          <>
            <Text style={label}>{t("Lead bot")}</Text>
            <NativeMenu
              compact
              title={t("Lead bot")}
              accessibilityLabel={t("Lead bot")}
              accessibilityValue={leadBot?.name}
              disabled={pending}
              options={selected.flatMap((id) => {
                const bot = bots.find((candidate) => candidate.id === id);
                return bot ? [{ value: bot.id, label: bot.name }] : [];
              })}
              selected={lead}
              onSelect={setLeadBotId}
              style={{ ...field, flexDirection: "row", alignItems: "center", gap: 10 }}
            >
              {leadBot ? (
                <BotAvatar
                  color={leadBot.color}
                  identity={leadBot.id}
                  shapeSeed={leadBot.shapeSeed}
                  size={22}
                />
              ) : null}
              <Text style={{ flex: 1, color: tokens.foreground, fontSize: 16 }}>
                {leadBot?.name}
              </Text>
              <NativeSymbol
                ios="chevron.up.chevron.down"
                android="chevron-expand"
                size={15}
                color={tokens.mutedForeground}
              />
            </NativeMenu>
          </>
        ) : null}
        {error ? <Text style={{ color: tokens.destructive, marginTop: 12 }}>{error}</Text> : null}
        <Pressable
          onPress={() => void save()}
          disabled={
            !name.trim() ||
            selected.length < GROUP_MEMBER_MIN ||
            selected.length > GROUP_MEMBER_MAX ||
            pending
          }
          style={{
            marginTop: 24,
            backgroundColor: tokens.primary,
            opacity:
              !name.trim() ||
              selected.length < GROUP_MEMBER_MIN ||
              selected.length > GROUP_MEMBER_MAX ||
              pending
                ? 0.5
                : 1,
            borderRadius: 11,
            padding: 14,
            alignItems: "center",
          }}
        >
          <Text style={{ color: tokens.primaryForeground, fontSize: 16, fontWeight: "600" }}>
            {pending ? t("Saving…") : t("Save")}
          </Text>
        </Pressable>
        <Pressable
          onPress={remove}
          style={{
            marginTop: 16,
            borderRadius: 11,
            borderWidth: 1,
            borderColor: tokens.border,
            padding: 14,
            alignItems: "center",
          }}
        >
          <Text style={{ color: tokens.destructive, fontSize: 16 }}>{t("Delete group")}</Text>
        </Pressable>
      </ScrollView>
    </>
  );
}
