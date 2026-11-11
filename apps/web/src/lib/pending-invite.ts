const PENDING_INVITE_KEY = "tangow:pending-invite";

/** localStorage, not sessionStorage: sign up's email verification opens a new tab. */
export function pendingInvite(): string | null {
  try {
    return window.localStorage.getItem(PENDING_INVITE_KEY);
  } catch {
    return null;
  }
}

export function holdInvite(token: string): void {
  try {
    window.localStorage.setItem(PENDING_INVITE_KEY, token);
  } catch {
    // Without storage the person opens the link again after signing in.
  }
}

export function dropInvite(): void {
  try {
    window.localStorage.removeItem(PENDING_INVITE_KEY);
  } catch {}
}

export function invitePath(token: string): string {
  return `/invite/${encodeURIComponent(token)}`;
}
