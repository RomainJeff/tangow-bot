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

export interface RakazoDesktopUpdate {
  state: () => Promise<DesktopUpdateState>;
  check: () => Promise<DesktopUpdateState>;
  download: () => Promise<DesktopUpdateState>;
  /** Quits and relaunches into the downloaded release; only useful once `phase` is `ready`. */
  install: () => Promise<DesktopUpdateState>;
}

export interface RakazoDesktopOAuthCallback {
  code: string;
  state?: string;
}

export interface RakazoDesktop {
  /** Only the isolated local settings window is authorized to call this bridge. */
  localSettings?: {
    request: (pathname: string, body: string) => Promise<{ status: number; body: string }>;
  };
  platform: string;
  window: {
    close: () => Promise<void>;
    minimize: () => Promise<void>;
    toggleMaximize: () => Promise<void>;
    state: () => Promise<{ minimized: boolean; maximized: boolean; fullScreen: boolean }>;
  };
  update: RakazoDesktopUpdate;
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
    onCallback: (listener: (callback: RakazoDesktopOAuthCallback) => void) => () => void;
  };
}

/**
 * How the desktop app was pointed at a Rakazo server during first-run setup.
 * `new` is the Docker Compose stack this app installs and runs on the same computer.
 */
export type DesktopInstanceMode = "new" | "existing";

export interface DesktopSetup {
  mode: DesktopInstanceMode;
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
  defaultLocalUrl: string;
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

export interface DesktopStackProbeResponse {
  ok: true;
  imageTag: string;
}

/**
 * Lifecycle of the Docker Compose stack the desktop app manages for mode `new`.
 * `docker-missing` and `docker-not-running` wait for the person to act; `ready` and
 * `failed` are terminal until the next start.
 */
export type DesktopLocalStackPhase =
  | "idle"
  | "checking-docker"
  | "docker-missing"
  | "docker-not-running"
  | "preparing"
  | "pulling"
  | "starting"
  | "waiting-healthy"
  | "ready"
  | "failed";

export interface DesktopLocalStackState {
  phase: DesktopLocalStackPhase;
  /** One actionable sentence; null while the stack is progressing normally. */
  message: string | null;
  /** Bounded tail of docker output for the current attempt. */
  output: string[];
  /** Bytes pulled per image layer in the current attempt; the sum is the only progress Docker reports. */
  layerBytes: Record<string, number>;
  /** Image tag this app launches (`v<app version>` for installed builds, `edge` otherwise). */
  imageTag: string;
}

export type DesktopSetupLink = "docker-desktop" | "orbstack" | "docker-engine";

/**
 * Bridge exposed only to the first-run setup window. The app window keeps the
 * narrower `rakazoDesktop` bridge so a connected server can never re-point the app.
 */
export interface RakazoSetup {
  /** Used only to reserve space for native window controls in the local setup UI. */
  platform: string;
  state: () => Promise<DesktopSetupState>;
  test: (url: string, access?: DesktopAccessCredentials | null) => Promise<DesktopReachability>;
  save: (
    setup: DesktopSetup,
    access?: DesktopAccessCredentials | null,
  ) => Promise<{ ok: boolean; error?: string }>;
  quit: () => Promise<void>;
  /** Opens one of the Docker install pages in the system browser. */
  openLink: (link: DesktopSetupLink) => Promise<void>;
  /** The Docker Compose stack this app installs and runs for mode `new`. */
  stack: {
    state: () => Promise<DesktopLocalStackState>;
    /** Starts (or retries) the stack; a no-op while a start is already in flight. */
    start: () => Promise<DesktopLocalStackState>;
    /** Fires on every state change so progress never depends on a renderer timer. */
    onChange: (listener: (state: DesktopLocalStackState) => void) => void;
  };
}
