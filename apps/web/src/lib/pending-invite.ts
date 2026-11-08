const PENDING_INVITE_KEY = "rakazo:pending-invite";

/**
 * An invite link opened while signed out waits here through sign in or sign up.
 * localStorage, not sessionStorage: the email verification link opens a new tab.
 */
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
  } catch {
    // Nothing to clear.
  }
}

export function invitePath(token: string): string {
  return `/invite/${encodeURIComponent(token)}`;
}
