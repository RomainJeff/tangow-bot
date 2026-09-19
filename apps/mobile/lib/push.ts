import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { rpc } from "./api";
import { t } from "./i18n";

/**
 * Registers this device for push with the server. Returns silently when the user
 * declined notifications or when there is no EAS project id to mint a token against
 * (Expo Go), and throws otherwise: a token that cannot be minted or stored means the
 * device stops being paged, so the failure has to reach the caller instead of dying
 * in a bare catch.
 */
export async function registerPushToken() {
  const existing = await Notifications.getPermissionsAsync();
  const granted = existing.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return;
  const projectId = Constants.easConfig?.projectId ?? Constants.expoConfig?.extra?.eas?.projectId;
  if (!projectId) return;
  let token: string;
  try {
    token = (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch (cause) {
    // Expo's own message names the real cause — a project id the build was not signed
    // for, missing push credentials, a simulator — so keep it rather than a generic one.
    throw new Error(
      t("Could not get a push token: {reason}", {
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
    );
  }
  if (!token) return;
  await rpc("notifications/registerPush", { token });
}

export async function unregisterPushToken() {
  await rpc("notifications/unregisterPush").catch(() => undefined);
}
