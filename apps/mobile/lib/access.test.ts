import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import * as SecureStore from "expo-secure-store";
import { accessHeaders, defaultAccess, isAccessLoginUrl, resolveAccessInput } from "./access.js";
import {
  accessFor,
  cachedAccess,
  currentAccessHeaders,
  loadAccess,
  saveAccess,
} from "./access-store.js";

const getItemAsync = vi.mocked(SecureStore.getItemAsync);
const setItemAsync = vi.mocked(SecureStore.setItemAsync);
const deleteItemAsync = vi.mocked(SecureStore.deleteItemAsync);

const TOKEN = { clientId: "id.access", clientSecret: "secret" };

beforeEach(async () => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  getItemAsync.mockResolvedValue(null);
  setItemAsync.mockResolvedValue(undefined);
  deleteItemAsync.mockResolvedValue(undefined);
  await loadAccess("https://app.example.com");
});

describe("accessHeaders", () => {
  it("emits the Cloudflare header pair, or nothing", () => {
    expect(accessHeaders(TOKEN)).toEqual({
      "CF-Access-Client-Id": "id.access",
      "CF-Access-Client-Secret": "secret",
    });
    expect(accessHeaders(null)).toEqual({});
  });
});

describe("isAccessLoginUrl", () => {
  it.each([
    ["https://acme.cloudflareaccess.com/cdn-cgi/access/login/app.example.com", true],
    ["https://cloudflareaccess.com", true],
    ["https://app.example.com/rpc/health", false],
    ["https://notcloudflareaccess.com.evil.example", false],
    ["not a url", false],
    [null, false],
  ])("%s -> %s", (url, expected) => {
    expect(isAccessLoginUrl(url)).toBe(expected);
  });
});

describe("storage", () => {
  it("round-trips a token for its origin and clears it", async () => {
    expect(await saveAccess("https://app.example.com", TOKEN)).toBe(true);
    expect(setItemAsync).toHaveBeenCalledWith(
      "tangow.cf_access",
      JSON.stringify({ ...TOKEN, origin: "https://app.example.com" }),
    );
    expect(cachedAccess()).toEqual({ ...TOKEN, origin: "https://app.example.com" });

    expect(await saveAccess("https://app.example.com", null)).toBe(true);
    expect(deleteItemAsync).toHaveBeenCalledWith("tangow.cf_access");
    expect(cachedAccess()).toBeNull();
  });

  it("ignores a token stored for a different origin", async () => {
    getItemAsync.mockResolvedValue(JSON.stringify({ ...TOKEN, origin: "https://old.example.com" }));
    expect(await loadAccess("https://app.example.com")).toBeNull();
    expect(currentAccessHeaders("https://app.example.com", "https://app.example.com")).toEqual({});
  });

  it("reports a failed write instead of silently dropping the token", async () => {
    setItemAsync.mockRejectedValue(new Error("keychain locked"));
    expect(await saveAccess("https://app.example.com", TOKEN)).toBe(false);
  });
});

describe("accessFor", () => {
  it("uses the build-time token only for the build-time origin", () => {
    vi.stubEnv("EXPO_PUBLIC_CF_ACCESS_CLIENT_ID", "build.access");
    vi.stubEnv("EXPO_PUBLIC_CF_ACCESS_CLIENT_SECRET", "build-secret");
    expect(defaultAccess()).toEqual({ clientId: "build.access", clientSecret: "build-secret" });
    expect(accessFor("https://app.example.com", "https://app.example.com")).toEqual({
      clientId: "build.access",
      clientSecret: "build-secret",
    });
    expect(accessFor("https://other.example.com", "https://app.example.com")).toBeNull();
  });

  it("ignores a half-configured build-time token", () => {
    vi.stubEnv("EXPO_PUBLIC_CF_ACCESS_CLIENT_ID", "build.access");
    expect(defaultAccess()).toBeNull();
  });

  it("prefers the stored token over the build-time one", async () => {
    vi.stubEnv("EXPO_PUBLIC_CF_ACCESS_CLIENT_ID", "build.access");
    vi.stubEnv("EXPO_PUBLIC_CF_ACCESS_CLIENT_SECRET", "build-secret");
    await saveAccess("https://app.example.com", TOKEN);
    expect(accessFor("https://app.example.com", "https://app.example.com")).toEqual({
      ...TOKEN,
      origin: "https://app.example.com",
    });
  });
});

describe("resolveAccessInput", () => {
  const stored = { ...TOKEN, origin: "https://app.example.com" };

  it("keeps the stored secret when the box is left empty", () => {
    expect(
      resolveAccessInput(
        { clientId: "id.access", clientSecret: "" },
        stored,
        "https://app.example.com",
      ),
    ).toEqual(TOKEN);
  });

  it("clears the token when both fields are emptied", () => {
    expect(
      resolveAccessInput({ clientId: "", clientSecret: "" }, stored, "https://app.example.com"),
    ).toBeNull();
  });

  it("does not carry a stored secret over to a different client ID or origin", () => {
    expect(
      resolveAccessInput(
        { clientId: "other.access", clientSecret: "" },
        stored,
        "https://app.example.com",
      ),
    ).toBeNull();
    expect(
      resolveAccessInput(
        { clientId: "id.access", clientSecret: "" },
        stored,
        "https://other.example.com",
      ),
    ).toBeNull();
  });

  it("takes a freshly entered pair", () => {
    expect(
      resolveAccessInput(
        { clientId: " new.access ", clientSecret: " new-secret " },
        stored,
        "https://app.example.com",
      ),
    ).toEqual({ clientId: "new.access", clientSecret: "new-secret" });
  });
});
