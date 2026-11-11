import { describe, expect, it, vi } from "vitest";
import {
  assertProfileImage,
  buildTrustedOrigins,
  isBlockedAuthPath,
  passwordResetEmail,
  resolveSignupPolicy,
} from "./index.js";

describe("auth policy", () => {
  it("blocks every Better Auth organization endpoint, reads and leave included", () => {
    expect(isBlockedAuthPath("/organization/list-members")).toBe(true);
    expect(isBlockedAuthPath("/organization/leave")).toBe(true);
    expect(isBlockedAuthPath("/get-session")).toBe(false);
  });
});

describe("buildTrustedOrigins", () => {
  it("adds the localhost twin for a 127.0.0.1 web origin", () => {
    expect(
      buildTrustedOrigins({
        webOrigin: "http://127.0.0.1:5173",
        baseURL: "http://127.0.0.1:5173",
      }),
    ).toEqual(expect.arrayContaining(["http://127.0.0.1:5173", "http://localhost:5173"]));
  });

  it("keeps extraOrigins and does not twin non-loopback hosts", () => {
    expect(
      buildTrustedOrigins({
        webOrigin: "https://app.example.test",
        baseURL: "https://api.example.test",
        extraOrigins: ["https://extra.example.test"],
      }),
    ).toEqual([
      "https://app.example.test",
      "https://api.example.test",
      "https://extra.example.test",
    ]);
  });
});

describe("passwordResetEmail", () => {
  it("keeps the reset URL in text and escapes user-controlled HTML", () => {
    const message = passwordResetEmail(
      { id: "user-1", email: "ada@example.test", name: '<Ada & "team">' },
      "https://tangow.test/reset-password?token=secret&next=1",
    );

    expect(message).toMatchObject({
      to: "ada@example.test",
      subject: "Reset your Tangow password",
    });
    expect(message.text).toContain("https://tangow.test/reset-password?token=secret&next=1");
    expect(message.html).toContain("&lt;Ada &amp; &quot;team&quot;&gt;");
    expect(message.html).toContain("token=secret&amp;next=1");
    expect(message.html).not.toContain('<Ada & "team">');
  });
});

describe("resolveSignupPolicy", () => {
  it("uses environment defaults before deployment settings exist", async () => {
    const prisma = {
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    await expect(
      resolveSignupPolicy(prisma as never, {
        signupsEnabled: "false",
        signupAllowlist: "you@example.com,@company.test",
      }),
    ).resolves.toEqual({
      enabled: false,
      allowlist: ["you@example.com", "@company.test"],
    });
  });

  it("keeps using the environment policy for a pre-upgrade uninitialized row", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn().mockResolvedValue({
          signupsEnabled: true,
          signupAllowlist: "",
          signupPolicyInitialized: false,
        }),
      },
    };
    await expect(
      resolveSignupPolicy(prisma as never, {
        signupsEnabled: "false",
        signupAllowlist: "existing-policy@example.com",
      }),
    ).resolves.toEqual({ enabled: false, allowlist: ["existing-policy@example.com"] });
  });

  it("uses live deployment settings as the effective policy after initial seeding", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn().mockResolvedValue({
          signupsEnabled: false,
          signupAllowlist: "approved@example.com",
          signupPolicyInitialized: true,
        }),
      },
    };
    await expect(
      resolveSignupPolicy(prisma as never, {
        signupsEnabled: "false",
        signupAllowlist: "environment-only@example.com",
      }),
    ).resolves.toEqual({ enabled: false, allowlist: ["approved@example.com"] });
  });
});

describe("assertProfileImage", () => {
  const payload = Buffer.from("tiny").toString("base64");

  it("accepts the supported raster data URLs", () => {
    for (const mimeType of ["png", "jpeg", "webp"]) {
      expect(() => assertProfileImage(`data:image/${mimeType};base64,${payload}`)).not.toThrow();
    }
  });

  it("accepts clearing the photo", () => {
    expect(() => assertProfileImage(null)).not.toThrow();
    expect(() => assertProfileImage(undefined)).not.toThrow();
    expect(() => assertProfileImage("")).not.toThrow();
  });

  it("rejects svg, which can carry script", () => {
    expect(() => assertProfileImage(`data:image/svg+xml;base64,${payload}`)).toThrow();
    expect(() => assertProfileImage('data:image/svg+xml,<svg onload="alert(1)"/>')).toThrow();
  });

  it("rejects remote urls that would leak the viewer's IP", () => {
    expect(() => assertProfileImage("https://tracker.example.test/pixel.png")).toThrow();
    expect(() => assertProfileImage("http://tracker.example.test/pixel.png")).toThrow();
  });

  it("rejects malformed base64", () => {
    expect(() => assertProfileImage("data:image/png;base64,not base64!!")).toThrow();
    expect(() => assertProfileImage("data:image/png;base64,")).toThrow();
  });

  it("rejects a payload above the 32 KB session budget", () => {
    expect(() => assertProfileImage(`data:image/webp;base64,${"A".repeat(32 * 1024)}`)).toThrow();
  });
});
