import type { ConfigContext, ExpoConfig } from "expo/config";

export default ({ config }: ConfigContext): ExpoConfig => {
  if (process.env.EAS_BUILD_PROFILE === "production") {
    const apiUrl = process.env.EXPO_PUBLIC_API_URL;
    if (!apiUrl) {
      throw new Error(
        "EXPO_PUBLIC_API_URL must be set in the EAS production environment before building for the App Store.",
      );
    }

    let parsed: URL;
    try {
      parsed = new URL(apiUrl);
    } catch {
      throw new Error("EXPO_PUBLIC_API_URL must be a valid URL.");
    }
    if (parsed.protocol !== "https:") {
      throw new Error("EXPO_PUBLIC_API_URL must use HTTPS for production builds.");
    }
  }

  // A half-configured service token silently produces a build that cannot reach
  // an Access-protected server, so fail the build instead.
  const accessId = process.env.EXPO_PUBLIC_CF_ACCESS_CLIENT_ID;
  const accessSecret = process.env.EXPO_PUBLIC_CF_ACCESS_CLIENT_SECRET;
  if (Boolean(accessId) !== Boolean(accessSecret)) {
    throw new Error(
      "EXPO_PUBLIC_CF_ACCESS_CLIENT_ID and EXPO_PUBLIC_CF_ACCESS_CLIENT_SECRET must be set together.",
    );
  }

  return config as ExpoConfig;
};
