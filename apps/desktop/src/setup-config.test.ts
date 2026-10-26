import { describe, expect, it, vi } from "vitest";
import {
  accessHeaders,
  isRakazoHealth,
  normalizeServerUrl,
  PROBE_RESPONSE_LIMIT_BYTES,
  parseAccessInput,
  parseSetupInput,
  parseStoredSetup,
  probeFailureMessage,
  readProbeJson,
  resolveAccessInput,
  resolveStartupTarget,
  safeExternalUrl,
  serializeSetup,
  servesBundledRenderer,
  sessionPartitionForServerUrl,
} from "./setup-config.js";

describe("server address normalization", () => {
  it("assumes http locally and https for a bare public host", () => {
    expect(normalizeServerUrl("127.0.0.1:5173")).toBe("http://127.0.0.1:5173");
    expect(normalizeServerUrl("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeServerUrl("192.168.1.20:3100")).toBe("http://192.168.1.20:3100");
    expect(normalizeServerUrl("rakazo.example.com")).toBe("https://rakazo.example.com");
  });

  it("keeps an explicit secure scheme and port but stores only the origin", () => {
    expect(normalizeServerUrl("https://rakazo.example.com")).toBe("https://rakazo.example.com");
    expect(normalizeServerUrl("https://rakazo.example.com:8443/team")).toBe(
      "https://rakazo.example.com:8443",
    );
  });

  it("trims surrounding space, trailing slashes, queries, and fragments", () => {
    expect(normalizeServerUrl("  http://127.0.0.1:5173/  ")).toBe("http://127.0.0.1:5173");
    expect(normalizeServerUrl("http://127.0.0.1:5173///")).toBe("http://127.0.0.1:5173");
    expect(normalizeServerUrl("http://127.0.0.1:5173/?next=/bots#top")).toBe(
      "http://127.0.0.1:5173",
    );
  });

  it("rejects cleartext public servers but permits private-network development", () => {
    expect(normalizeServerUrl("http://rakazo.example.com")).toBeNull();
    expect(normalizeServerUrl("http://10.0.0.8:3100")).toBe("http://10.0.0.8:3100");
    expect(normalizeServerUrl("http://[fd00::1]:3100")).toBe("http://[fd00::1]:3100");
  });

  it("rejects cleartext link-local addresses used by cloud metadata endpoints", () => {
    expect(normalizeServerUrl("http://169.254.169.254")).toBeNull();
    expect(normalizeServerUrl("http://169.254.1.1:80")).toBeNull();
    expect(normalizeServerUrl("http://[fe80::1]:3100")).toBeNull();
    // HTTPS to link-local still normalizes; the health probe must match Rakazo.
    expect(normalizeServerUrl("https://169.254.169.254")).toBe("https://169.254.169.254");
  });

  it.each(["", "   ", "not a url", "ftp://example.com", "file:///etc/passwd", "http://"])(
    "rejects an address that cannot reach a Rakazo server (%s)",
    (value) => {
      expect(normalizeServerUrl(value)).toBeNull();
    },
  );

  it("rejects embedded credentials rather than writing them to disk", () => {
    expect(normalizeServerUrl("https://user:secret@rakazo.example.com")).toBeNull();
  });
});

describe("saved setup", () => {
  it("round-trips through the on-disk format", () => {
    const setup = { serverUrl: "https://rakazo.example.com" };
    expect(parseStoredSetup(serializeSetup(setup))).toEqual(setup);
  });

  it("normalizes the address it reads back", () => {
    expect(parseStoredSetup('{"serverUrl":"127.0.0.1:5173/"}')).toEqual({
      serverUrl: "http://127.0.0.1:5173",
    });
  });

  it("keeps the address of a setup saved by an older version", () => {
    expect(parseStoredSetup('{"mode":"new","serverUrl":"http://127.0.0.1:45173"}')).toEqual({
      serverUrl: "http://127.0.0.1:45173",
    });
  });

  it.each([
    ["not json", "{oops"],
    ["a non-object", '"nope"'],
    ["a missing address", "{}"],
    ["an unusable address", '{"serverUrl":"ftp://example.com"}'],
  ])("discards %s so setup runs again", (_label, raw) => {
    expect(parseStoredSetup(raw)).toBeNull();
  });

  it("rejects an untrusted payload that is not a setup", () => {
    expect(parseSetupInput(null)).toBeNull();
    expect(parseSetupInput({ serverUrl: 5173 })).toBeNull();
  });
});

describe("startup target", () => {
  const saved = { serverUrl: "https://rakazo.example.com" };

  it("runs setup on a first launch", () => {
    expect(resolveStartupTarget({})).toEqual({ kind: "setup" });
  });

  it("opens the saved instance on later launches", () => {
    expect(resolveStartupTarget({ saved })).toEqual({
      kind: "app",
      url: "https://rakazo.example.com",
      source: "saved",
    });
  });

  it("lets RAKAZO_WEB_URL point the shell anywhere without touching saved setup", () => {
    expect(resolveStartupTarget({ envUrl: "http://127.0.0.1:4321", saved })).toEqual({
      kind: "app",
      url: "http://127.0.0.1:4321",
      source: "env",
    });
  });

  it("ignores an empty RAKAZO_WEB_URL", () => {
    expect(resolveStartupTarget({ envUrl: "   ", saved }).kind).toBe("app");
    expect(resolveStartupTarget({ envUrl: "   ", saved })).toMatchObject({ source: "saved" });
  });

  it("re-runs setup when forced, even with saved configuration", () => {
    expect(resolveStartupTarget({ saved, forceSetup: true })).toEqual({ kind: "setup" });
  });

  it("re-runs setup when the saved address is unusable", () => {
    expect(resolveStartupTarget({ saved: { serverUrl: "nope://x" } })).toEqual({
      kind: "setup",
    });
  });
});

describe("bundled renderer eligibility", () => {
  it("stands in for http(s) origins only", () => {
    expect(servesBundledRenderer("http://127.0.0.1:5173")).toBe(true);
    expect(servesBundledRenderer("https://rakazo.example.com")).toBe(true);
    expect(servesBundledRenderer("data:text/html,<p>fixture</p>")).toBe(false);
    expect(servesBundledRenderer("nonsense")).toBe(false);
  });
});

describe("remote-content isolation", () => {
  it("uses a stable, opaque session partition per server origin", () => {
    const first = sessionPartitionForServerUrl("https://one.example.com/path");
    expect(first).toBe(sessionPartitionForServerUrl("https://one.example.com/other"));
    expect(first).not.toBe(sessionPartitionForServerUrl("https://one.example.com:8443"));
    expect(first).toMatch(/^persist:dax-[a-f0-9]{24}$/);
    expect(first).not.toContain("one.example.com");
    expect(sessionPartitionForServerUrl("data:text/html,fixture")).toBeNull();
  });

  it("opens only web URLs outside Electron", () => {
    expect(safeExternalUrl("https://example.com/docs")).toBe("https://example.com/docs");
    expect(safeExternalUrl("mailto:person@example.com")).toBeNull();
    expect(safeExternalUrl("file:///etc/passwd")).toBeNull();
  });
});

describe("Rakazo health response", () => {
  it("requires the public RPC health contract", () => {
    expect(isRakazoHealth({ json: { ok: true, version: "0.1.0" } })).toBe(true);
    expect(isRakazoHealth({ json: { ok: true } })).toBe(false);
    expect(isRakazoHealth({ ok: true, version: "0.1.0" })).toBe(false);
  });
});

describe("probe response", () => {
  it("parses a bounded JSON probe response", async () => {
    await expect(readProbeJson(Response.json({ ok: true }))).resolves.toEqual({ ok: true });
  });

  it("rejects a declared oversized response without waiting for cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-length": String(PROBE_RESPONSE_LIMIT_BYTES + 1) },
    });

    await expect(readProbeJson(response)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects a streamed oversized response without waiting for cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => undefined));
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(PROBE_RESPONSE_LIMIT_BYTES + 1));
        },
        cancel,
      }),
    );

    await expect(readProbeJson(response)).resolves.toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe("probe failures", () => {
  it.each([
    ["TimeoutError", "Timed out reaching that address."],
    ["AbortError", "Timed out reaching that address."],
  ])("explains %s", (name, expected) => {
    const error = new Error("stopped");
    error.name = name;
    expect(probeFailureMessage(error)).toBe(expected);
  });

  it.each([
    ["net::ERR_CONNECTION_REFUSED", "Nothing is listening at that address yet."],
    ["net::ERR_NAME_NOT_RESOLVED", "That host could not be found."],
    ["net::ERR_CERT_AUTHORITY_INVALID", "The server's HTTPS certificate was rejected."],
    ["something else entirely", "Could not reach that address (something else entirely)."],
    ["", "Could not reach that address."],
    [
      "Redirect was cancelled",
      "That address redirects elsewhere. Enter the final Rakazo server address, or add a Cloudflare Access service token if the server sits behind Access.",
    ],
  ])("explains %s", (message, expected) => {
    expect(probeFailureMessage(new Error(message))).toBe(expected);
  });
});

describe("cloudflare access credentials", () => {
  const stored = {
    clientId: "abc.access",
    clientSecret: "s3cret",
    origin: "https://rakazo.example.com",
  };

  it("accepts a complete token and trims it", () => {
    expect(parseAccessInput({ clientId: " abc.access ", clientSecret: " s3cret " })).toEqual({
      clientId: "abc.access",
      clientSecret: "s3cret",
    });
  });

  it.each([
    ["both blank", { clientId: "", clientSecret: "" }],
    ["secret missing", { clientId: "abc.access", clientSecret: "  " }],
    ["id missing", { clientId: "", clientSecret: "s3cret" }],
    ["wrong shape", { clientId: 1, clientSecret: 2 }],
    ["not an object", "abc.access"],
  ])("rejects %s", (_name, value) => {
    expect(parseAccessInput(value)).toBeNull();
  });

  it("keeps the stored secret when the id is unchanged and the secret is left empty", () => {
    expect(
      resolveAccessInput({ clientId: "abc.access", clientSecret: "" }, stored, stored.origin),
    ).toEqual({ clientId: "abc.access", clientSecret: "s3cret" });
  });

  it("never reuses a stored secret for another origin or another id", () => {
    expect(
      resolveAccessInput(
        { clientId: "abc.access", clientSecret: "" },
        stored,
        "https://other.example.com",
      ),
    ).toBeNull();
    expect(
      resolveAccessInput({ clientId: "other.access", clientSecret: "" }, stored, stored.origin),
    ).toBeNull();
  });

  it("clears the token when both fields are emptied", () => {
    expect(
      resolveAccessInput({ clientId: "", clientSecret: "" }, stored, stored.origin),
    ).toBeNull();
  });

  it("builds the service token headers", () => {
    expect(accessHeaders({ clientId: "abc.access", clientSecret: "s3cret" })).toEqual({
      "CF-Access-Client-Id": "abc.access",
      "CF-Access-Client-Secret": "s3cret",
    });
    expect(accessHeaders(null)).toBeNull();
  });
});
