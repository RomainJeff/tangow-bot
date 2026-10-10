import type {
  Bot,
  ComputerMode,
  Me,
  ModelCatalogEntry,
  ModelCredential,
  VoiceInfo,
} from "@rakazo/contracts";
import {
  type Draft,
  draftConflicts,
  type FieldSaveState,
  fieldValue,
  type ModelCatalog,
  saveKey,
} from "@rakazo/core";
import { useEffect, useState, useSyncExternalStore } from "react";
import { rpc } from "./api";
import { botRecords, botSaves, modelCatalogRead, viewer, voicesRead } from "./bot-page-state";
import type { ReadState, SharedRead } from "./shared-read";

export type BotPatch = Partial<
  Pick<
    Bot,
    | "name"
    | "title"
    | "description"
    | "instructions"
    | "color"
    | "shapeSeed"
    | "notifyOnFinish"
    | "voiceId"
    | "autoSpeak"
    | "chattyReplies"
    | "modelProvider"
    | "modelId"
    | "thinkingLevel"
  >
>;

/** What every part of the page works on: the bot, whose saves these are, and whether it may change. */
export type BotPageContext = { bot: Bot; userId: string; readOnly: boolean };

export function readBotPage(botId: string): Promise<void> {
  return botRecords.read(botId, () => rpc<Bot>("bots/get", { botId }));
}

/** Who is signed in, read once a session: it scopes every save key. */
export function readViewer(): Promise<Me> {
  if (viewer.current) return viewer.current;
  const read: Promise<Me> = rpc<Me>("me").catch((error: unknown) => {
    if (viewer.current === read) viewer.current = null;
    throw error;
  });
  viewer.current = read;
  return read;
}

export function updateBot(botId: string, patch: BotPatch): Promise<Bot> {
  return botRecords.write(
    botId,
    () => rpc<Bot>("bots/update", { botId, ...patch }),
    Object.keys(patch),
  );
}

/** Its own call, never chained with `updateBot`: the server refuses it while the bot runs. */
export function setBotComputer(botId: string, mode: ComputerMode): Promise<Bot> {
  return botRecords.write(botId, () => rpc<Bot>("bots/setComputer", { botId, mode }), [
    "computerMode",
  ]);
}

function useBotRecord(botId: string): Bot | undefined {
  const read = () => botRecords.bot(botId);
  return useSyncExternalStore(botRecords.subscribe, read, read);
}

export interface FieldSave<V> {
  state: FieldSaveState<V>;
  /**
   * The value being saved, or the value just saved while "Saved" shows, else
   * the server value: a failed switch turns back by itself.
   */
  value: V;
  /** Unsaved text kept in memory; it conflicts when the server value moved since it began. */
  draft: Draft<V> | undefined;
  conflict: boolean;
  save: (value: V) => Promise<void>;
  /** The state now, read after awaiting `save` (the rendered `state` is from before it). */
  current: () => FieldSaveState<V>;
  retry: () => Promise<void>;
  dismiss: () => void;
  setDraft: (value: V | null) => void;
}

/** One bot setting, saved through the shared store under this person, space, bot and field. */
export function useBotField<V>(
  { bot, userId }: BotPageContext,
  field: string,
  serverValue: V,
  commit: (value: V) => Promise<unknown>,
): FieldSave<V> {
  const key = saveKey({ userId, spaceId: bot.spaceId }, bot.id, field);
  const subscribe = (listener: () => void) => botSaves.subscribe(key, listener);
  const readState = () => botSaves.state<V>(key);
  const readDraft = () => botSaves.draft<V>(key);
  const state = useSyncExternalStore(subscribe, readState, readState);
  const draft = useSyncExternalStore(subscribe, readDraft, readDraft);
  const value = fieldValue(state, serverValue);
  return {
    state,
    value,
    draft,
    conflict: draftConflicts(draft, value),
    save: (next) =>
      botSaves.save(key, next, async (sent) => {
        await commit(sent);
      }),
    current: readState,
    retry: () => botSaves.retry(key),
    dismiss: () => botSaves.dismiss(key),
    setDraft: (next) => botSaves.setDraft(key, next, fieldValue(readState(), serverValue)),
  };
}

/** A field of the bot written with `bots/update`. */
export function useBotSetting<K extends keyof BotPatch>(
  page: BotPageContext,
  field: K,
): FieldSave<Bot[K]> {
  return useBotField(page, field, page.bot[field], (value) =>
    updateBot(page.bot.id, { [field]: value } as BotPatch),
  );
}

/** A read the bot page shares between screens, read again when it is stale or on Retry. */
function useSharedRead<T>(read: SharedRead<T>, load: () => Promise<T>) {
  const state = useSyncExternalStore(read.subscribe, read.state, read.state);
  useEffect(() => {
    void read.refresh(load);
  }, [read, load]);
  return { state, retry: () => void read.refresh(load, { force: true }) };
}

export function loadModelCatalog(): Promise<ModelCatalog> {
  return Promise.all([
    rpc<ModelCredential[]>("models/credentials"),
    rpc<ModelCatalogEntry[]>("models/list"),
    readViewer(),
  ]).then(([credentials, catalog, me]) => ({ credentials, catalog, me }));
}

export function selectedModelCatalog(): SharedRead<ModelCatalog> {
  return modelCatalogRead;
}

/** The connections, catalog and space default a bot's model is chosen from. */
export function useModelCatalog(): { state: ReadState<ModelCatalog>; retry: () => void } {
  return useSharedRead(selectedModelCatalog(), loadModelCatalog);
}

function loadVoices(): Promise<VoiceInfo[]> {
  return rpc<VoiceInfo[]>("voice/voices", {});
}

export function useVoices(): { state: ReadState<VoiceInfo[]>; retry: () => void } {
  return useSharedRead(voicesRead, loadVoices);
}

/** The bot page's context once the bot and the signed-in person are known; reads the bot if this client has not. */
export function useBotPageContext(botId: string): BotPageContext | null {
  const bot = useBotRecord(botId);
  const [userId, setUserId] = useState<string | null>(null);
  // A failed read of the viewer is tried again whenever the bot is read again (a Retry).
  useEffect(() => {
    if (userId) return;
    let cancelled = false;
    void readViewer()
      .then((me) => {
        if (!cancelled) setUserId(me.userId);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [userId, bot]);
  const known = bot !== undefined;
  useEffect(() => {
    if (!known && botId) void readBotPage(botId).catch(() => undefined);
  }, [known, botId]);
  return bot && userId ? { bot, userId, readOnly: bot.archivedAt != null } : null;
}
