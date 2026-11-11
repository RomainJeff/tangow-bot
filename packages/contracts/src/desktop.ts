/**
 * `unsupported` covers an unpackaged build and a repository with no published releases, which is
 * the normal state for a fork. It is not an error the user needs to act on. Automatic checks stay
 * frozen after an empty feed; a manual check may retry when the install itself supports updates.
 */
export type DesktopUpdatePhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "unsupported"
  | "error";

export interface DesktopUpdateState {
  phase: DesktopUpdatePhase;
  /** The installed desktop release, which can drift from the server this app points at. */
  currentVersion: string;
  availableVersion: string | null;
  /** Download progress 0-100, only while `downloading`. */
  percent: number | null;
  message: string | null;
  checkedAt: string | null;
}

export interface TangowDesktopUpdate {
  state: () => Promise<DesktopUpdateState>;
  check: () => Promise<DesktopUpdateState>;
  download: () => Promise<DesktopUpdateState>;
  /** Quits and relaunches into the downloaded release; only useful once `phase` is `ready`. */
  install: () => Promise<DesktopUpdateState>;
}

export interface TangowDesktopOAuthCallback {
  code: string;
  state?: string;
}

export interface TangowDesktop {
  platform: string;
  window: {
    close: () => Promise<void>;
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    state: () => Promise<{ minimized: boolean; maximized: boolean; fullScreen: boolean }>;
  };
  update: TangowDesktopUpdate;
  /**
   * Link previews for sites that refuse the server: this computer reads the start of the page
   * (no cookies, public http(s) hosts only, 512 KiB at most) and the composer sends it to the
   * server. Null when the page cannot be read. Optional for older desktops.
   */
  pageHead?: {
    /** `id` names the read so `cancel` can stop it and free its slot. */
    read: (url: string, id: string) => Promise<{ head: string; contentType: string } | null>;
    /** Optional for desktops that predate it. */
    cancel?: (id: string) => Promise<void>;
  };
  oauth: {
    /**
     * Open system-browser auth. A redirect_uri must be HTTP loopback with state;
     * URLs without a redirect use backend polling. Optional for older desktops.
     */
    open?: (authorizationUrl: string) => Promise<void>;
    cancel?: (authorizationUrl: string) => Promise<void>;
    /**
     * Authorization codes captured from the system browser or a legacy popup.
     * Returns an unsubscribe function.
     */
    onCallback: (listener: (callback: TangowDesktopOAuthCallback) => void) => () => void;
  };
}

/** The Tangow server the desktop app was pointed at during first-run setup. */
export interface DesktopSetup {
  serverUrl: string;
}

/**
 * Cloudflare Access service token used to reach a server that sits behind Access.
 * Never part of `DesktopSetup`: the secret is stored encrypted, apart from setup.json.
 */
export interface DesktopAccessCredentials {
  clientId: string;
  clientSecret: string;
}

export interface DesktopSetupState {
  saved: DesktopSetup | null;
  /** Client ID of the stored Access token, so setup can show one is configured. */
  savedAccessClientId: string | null;
  /** Present when a saved or newly selected server could not be reopened. */
  error?: string;
}

export interface DesktopReachability {
  ok: boolean;
  /** HTTP status when the server answered, absent when it could not be reached. */
  status?: number;
  /** Normalized URL that was probed, absent when the input was not a usable URL. */
  url?: string;
  error?: string;
}

/**
 * Bridge exposed only to the first-run setup window. The app window keeps the
 * narrower `rakazoDesktop` bridge so a connected server can never re-point the app.
 */
export interface TangowSetup {
  /** Used only to reserve space for native window controls in the local setup UI. */
  platform: string;
  state: () => Promise<DesktopSetupState>;
  test: (url: string, access?: DesktopAccessCredentials | null) => Promise<DesktopReachability>;
  save: (
    setup: DesktopSetup,
    access?: DesktopAccessCredentials | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  quit: () => Promise<void>;
}
