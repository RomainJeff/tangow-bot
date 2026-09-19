import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  desktopOAuthCode,
  oauthStateOf,
  onDesktopOAuthCallback,
  type RakazoDesktop,
  type RakazoDesktopOAuthCallback,
  windowChromeKind,
} from "./desktop.js";

function desktop(platform: string): RakazoDesktop {
  const updateState = {
    phase: "unsupported" as const,
    currentVersion: "0.1.0",
    availableVersion: null,
    percent: null,
    message: "Automatic updates only run in an installed build.",
    checkedAt: null,
  };
  return {
    platform,
    window: {
      close: async () => undefined,
      minimize: async () => undefined,
      toggleMaximize: async () => undefined,
      state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
    },
    update: {
      state: async () => updateState,
      check: async () => updateState,
      download: async () => updateState,
      install: async () => updateState,
    },
    oauth: { onCallback: () => () => undefined },
  };
}

describe("window chrome", () => {
  it("does not paint fake traffic lights in the browser", () => {
    expect(windowChromeKind(undefined)).toBe("spacer");
  });

  it("leaves macOS traffic lights to Electron", () => {
    expect(windowChromeKind(desktop("darwin"))).toBe("darwin");
  });

  it("uses real window-control buttons on Windows and Linux", () => {
    expect(windowChromeKind(desktop("win32"))).toBe("controls");
    expect(windowChromeKind(desktop("linux"))).toBe("controls");
  });

  it("does not paint fake traffic lights into the browser shell or welcome page", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../pages");
    for (const file of [
      "Shell.tsx",
      "shell/sidebar.tsx",
      "shell/thread-header.tsx",
      "Welcome.tsx",
    ]) {
      expect(readFileSync(path.join(root, file), "utf8"), file).not.toContain("FF5F57");
    }
  });

  it("reserves room for window controls in the peer chat view", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../pages");
    const overlay = readFileSync(path.join(root, "PeerMessagesOverlay.tsx"), "utf8");
    expect(overlay).toContain("{desktopBridge() ? <WindowChrome /> : null}");
    expect(overlay).toContain('className="app-drag flex items-center justify-between');
    expect(overlay).not.toContain("FF5F57");
  });

  it("keeps conversation header controls clickable", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../pages");
    const shell = readFileSync(path.join(root, "shell/thread-header.tsx"), "utf8");
    expect(shell).toContain('className="app-drag flex h-header shrink-0 items-center');
    // The mobile-nav toggle is a roundIcon Button that stays out of the drag region.
    expect(shell).toContain('className="app-no-drag shrink-0 md:hidden"');
    // The bot-name trigger stays clickable (and out of the drag region) while
    // carrying its hover affordance.
    expect(shell).toContain(
      'className="app-no-drag -mx-2 flex min-w-0 items-center gap-3 rounded-lg px-2 py-1 transition-colors hover:bg-muted"',
    );
    // One computer button and one settings button, each out of the drag region.
    expect(shell.match(/data-testid="open-computer-panel"/g)).toHaveLength(1);
    expect(shell.match(/data-testid="open-settings-panel"/g)).toHaveLength(1);
    // No `<` in between: both attributes belong to the same element.
    expect(shell).toMatch(/data-testid="open-computer-panel"[^<]*?className="app-no-drag"/);
    expect(shell).toMatch(/data-testid="open-settings-panel"[^<]*?className="app-no-drag"/);
  });

  it("moves window chrome into the conversation header when the bots sidebar is collapsed", () => {
    const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "../pages");
    const shell = readFileSync(path.join(root, "shell/thread-header.tsx"), "utf8");
    expect(shell).toContain("{botsSidebarCollapsed && desktopBridge() ? <WindowChrome /> : null}");
  });
});

describe("captured OAuth callbacks", () => {
  it("sends the code and state as the compact form the paste flow accepts", () => {
    expect(desktopOAuthCode({ code: "ac_123", state: "verifier_456" })).toBe("ac_123#verifier_456");
  });

  it("sends a bare code when the provider redirects without state", () => {
    expect(desktopOAuthCode({ code: "ac_123" })).toBe("ac_123");
  });
});

describe("attempt correlation", () => {
  afterEach(() => vi.unstubAllGlobals());

  function bridgeEmitting() {
    let emit: (callback: RakazoDesktopOAuthCallback) => void = () => undefined;
    const unsubscribe = vi.fn();
    vi.stubGlobal("window", {
      rakazoDesktop: {
        ...desktop("linux"),
        oauth: {
          onCallback: (listener: (callback: RakazoDesktopOAuthCallback) => void) => {
            emit = listener;
            return unsubscribe;
          },
        },
      },
    });
    return { emit: (c: RakazoDesktopOAuthCallback) => emit(c), unsubscribe };
  }

  it("reads the attempt state out of the authorize URL", () => {
    expect(oauthStateOf("https://claude.ai/oauth/authorize?code=true&state=verifier_456")).toBe(
      "verifier_456",
    );
    expect(oauthStateOf("https://claude.ai/oauth/authorize?code=true")).toBeUndefined();
    expect(oauthStateOf("not a url")).toBeUndefined();
  });

  it("ignores a code captured for a different attempt", () => {
    const { emit } = bridgeEmitting();
    const received: string[] = [];
    onDesktopOAuthCallback((code) => received.push(code), "verifier_456");

    emit({ code: "stale", state: "verifier_000" });
    expect(received).toEqual([]);

    emit({ code: "ac_123", state: "verifier_456" });
    expect(received).toEqual(["ac_123#verifier_456"]);
  });

  it("accepts any code when the provider carries no state to correlate on", () => {
    const { emit } = bridgeEmitting();
    const received: string[] = [];
    onDesktopOAuthCallback((code) => received.push(code));

    emit({ code: "ac_123" });
    expect(received).toEqual(["ac_123"]);
  });

  it("no-ops in a browser without the desktop bridge", () => {
    vi.stubGlobal("window", {});
    const received: string[] = [];
    expect(() => onDesktopOAuthCallback((code) => received.push(code))()).not.toThrow();
    expect(received).toEqual([]);
  });
});
