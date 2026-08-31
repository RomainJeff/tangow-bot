/**
 * A Cloudflare Access service token. Stored with the origin it was entered for
 * so it is never sent to a different server after the endpoint changes.
 */
export type AccessCredentials = {
  clientId: string;
  clientSecret: string;
};

export type StoredAccess = AccessCredentials & { origin: string };

/**
 * A service token baked in at build time, for a fleet build that always talks to
 * one Access-protected server. `EXPO_PUBLIC_*` values are inlined into the JS
 * bundle, so this secret is readable by anyone who unpacks the app: use it only
 * for internally distributed builds, never for a public store release. It is
 * only ever sent to the build-time API origin.
 */
export function defaultAccess(): AccessCredentials | null {
  const clientId = process.env.EXPO_PUBLIC_CF_ACCESS_CLIENT_ID?.trim();
  const clientSecret = process.env.EXPO_PUBLIC_CF_ACCESS_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function accessHeaders(credentials: AccessCredentials | null): Record<string, string> {
  if (!credentials) return {};
  return {
    "CF-Access-Client-Id": credentials.clientId,
    "CF-Access-Client-Secret": credentials.clientSecret,
  };
}

/** Cloudflare bounces an unauthenticated request to the team's login domain. */
export function isAccessLoginUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "cloudflareaccess.com" || host.endsWith(".cloudflareaccess.com");
  } catch {
    return false;
  }
}

/** A complete token, or null when either field is blank. */
export function parseAccessInput(value: {
  clientId: string;
  clientSecret: string;
}): AccessCredentials | null {
  const clientId = value.clientId.trim();
  const clientSecret = value.clientSecret.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * The server sheet never renders a stored secret, so re-saving the same origin
 * with the client ID untouched and the secret box empty keeps the stored token
 * instead of silently dropping it. Anything else is taken literally, including
 * clearing the token by emptying both fields.
 */
export function resolveAccessInput(
  value: { clientId: string; clientSecret: string },
  stored: StoredAccess | null,
  origin: string,
): AccessCredentials | null {
  const entered = parseAccessInput(value);
  if (entered) return entered;
  if (!stored || stored.origin !== origin) return null;
  if (value.clientId.trim() !== stored.clientId || value.clientSecret.trim() !== "") return null;
  return { clientId: stored.clientId, clientSecret: stored.clientSecret };
}
