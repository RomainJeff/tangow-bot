import { requireNativeModule } from "expo";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";
import { accessFor } from "./access-store";
import { apiBaseWarning, defaultApiBase, normalizeApiBase } from "./endpoint";
import { t } from "./i18n";

export interface LiveNotificationSettings {
  liveConnection: boolean;
  messages: boolean;
  scheduledTasks: boolean;
  needsAttention: boolean;
}

export const DEFAULT_LIVE_NOTIFICATION_SETTINGS: LiveNotificationSettings = {
  liveConnection: false,
  messages: true,
  scheduledTasks: true,
  needsAttention: true,
};

type NativeNotifications = {
  getSettings(): Promise<LiveNotificationSettings>;
  setSettings(
    settings: LiveNotificationSettings,
    endpoint: string,
    token: string,
    spaceId: string,
    accessClientId: string,
    accessClientSecret: string,
  ): Promise<void>;
  resume(
    endpoint: string,
    token: string,
    spaceId: string,
    accessClientId: string,
    accessClientSecret: string,
  ): Promise<void>;
  stop(clearSession: boolean): Promise<void>;
  setOpenThread(botId: string | null, threadId: string | null): Promise<void>;
  openSettings(): Promise<void>;
  canPostPromotedNotifications(): Promise<boolean>;
  openPromotedSettings(): Promise<void>;
};

const nativeNotifications =
  Platform.OS === "android"
    ? requireNativeModule<NativeNotifications>("TangowNotifications")
    : null;

export type NotificationThreadTarget = { botId?: string; threadId?: string };

let openThread: NotificationThreadTarget | null = null;
let foregroundHandlerConfigured = false;

export function notificationTargetsThread(
  data: Record<string, unknown> | null | undefined,
  target: NotificationThreadTarget | null,
): boolean {
  if (!data || !target) return false;
  const dataThreadId = data.threadId ?? data["tangow.threadId"];
  if (target.threadId && dataThreadId) return dataThreadId === target.threadId;
  return Boolean(
    target.botId && (data.botId === target.botId || data["tangow.botId"] === target.botId),
  );
}

export type NotificationDestination =
  | { pathname: "/thread"; params: { botId: string; spaceId?: string } }
  | { pathname: "/group-thread"; params: { groupId: string; spaceId?: string } };

/** Where tapping a pushed bot notification leads: the group it spoke in, else its chat. */
export function notificationDestination(
  data: Record<string, unknown> | null | undefined,
): NotificationDestination | null {
  const text = (value: unknown) => (typeof value === "string" && value ? value : undefined);
  const spaceId = text(data?.spaceId);
  const space = spaceId ? { spaceId } : {};
  const groupId = text(data?.groupId);
  if (groupId) return { pathname: "/group-thread", params: { groupId, ...space } };
  const botId = text(data?.botId);
  return botId ? { pathname: "/thread", params: { botId, ...space } } : null;
}

/** True when the conversation a push leads to is already the screen on top. */
export function destinationIsOnScreen(
  destination: NotificationDestination,
  pathname: string,
  params: Record<string, string | string[] | undefined>,
): boolean {
  if (pathname !== destination.pathname) return false;
  return "groupId" in destination.params
    ? params.groupId === destination.params.groupId
    : params.botId === destination.params.botId && !params.groupId;
}

export function configureForegroundNotifications(): void {
  if (foregroundHandlerConfigured) return;
  foregroundHandlerConfigured = true;
  Notifications.setNotificationHandler({
    handleNotification: async ({ request }) => {
      const show = !notificationTargetsThread(request.content.data, openThread);
      return {
        shouldShowBanner: show,
        shouldShowList: show,
        shouldPlaySound: false,
        shouldSetBadge: true,
      };
    },
  });
}

export async function getLiveNotificationSettings(): Promise<LiveNotificationSettings> {
  return nativeNotifications?.getSettings() ?? DEFAULT_LIVE_NOTIFICATION_SETTINGS;
}

export async function setLiveNotificationSettings(
  settings: LiveNotificationSettings,
  endpoint: string,
  token: string,
  spaceId: string,
): Promise<void> {
  if (!nativeNotifications) return;
  const parsed = normalizeApiBase(endpoint);
  if (!parsed.ok) throw new Error(parsed.error);
  const endpointWarning = apiBaseWarning(parsed.url);
  if (endpointWarning) throw new Error(endpointWarning);
  if (settings.liveConnection) {
    const existing = await Notifications.getPermissionsAsync();
    const granted = existing.granted || (await Notifications.requestPermissionsAsync()).granted;
    if (!granted) throw new Error(t("Android blocked notifications."));
  }
  const access = accessFor(parsed.url, defaultApiBase());
  await nativeNotifications.setSettings(
    settings,
    parsed.url,
    token,
    spaceId,
    access?.clientId ?? "",
    access?.clientSecret ?? "",
  );
}

export async function resumeLiveNotifications(
  endpoint: string,
  token: string,
  spaceId: string,
): Promise<void> {
  if (!nativeNotifications || !token) return;
  const parsed = normalizeApiBase(endpoint);
  if (!parsed.ok || apiBaseWarning(parsed.url)) return;
  const access = accessFor(parsed.url, defaultApiBase());
  await nativeNotifications.resume(
    parsed.url,
    token,
    spaceId,
    access?.clientId ?? "",
    access?.clientSecret ?? "",
  );
}

export async function stopLiveNotifications(clearSession = false): Promise<void> {
  await nativeNotifications?.stop(clearSession);
}

export async function setOpenNotificationThread(
  target: NotificationThreadTarget | null,
): Promise<void> {
  openThread = target;
  await nativeNotifications?.setOpenThread(target?.botId ?? null, target?.threadId ?? null);
}

export async function dismissThreadNotifications(target: {
  botId?: string;
  threadId?: string;
}): Promise<void> {
  if (!target.botId && !target.threadId) return;
  const presented = await Notifications.getPresentedNotificationsAsync();
  await Promise.all(
    presented
      .filter(({ request }) => {
        const data = request.content.data ?? {};
        return notificationTargetsThread(data, target);
      })
      .map(({ request }) => Notifications.dismissNotificationAsync(request.identifier)),
  );
}

/**
 * Sets the app icon badge to the inbox's unread conversation total. iOS only: Android
 * launchers count the active notifications themselves, and overriding that would clear a
 * badge whose notifications are still posted.
 */
export async function syncAppBadge(unreadConversations: number): Promise<void> {
  if (Platform.OS !== "ios") return;
  await Notifications.setBadgeCountAsync(unreadConversations);
}

export async function openLiveNotificationSettings(): Promise<void> {
  await nativeNotifications?.openSettings();
}

export async function canPostPromotedNotifications(): Promise<boolean> {
  return nativeNotifications?.canPostPromotedNotifications() ?? true;
}

export async function openPromotedNotificationSettings(): Promise<void> {
  await nativeNotifications?.openPromotedSettings();
}
