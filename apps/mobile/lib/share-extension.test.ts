import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SHARE_TOKENS_SWIFT_PATH, shareTokensSwift } from "./share-extension-tokens";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("iOS share extension", () => {
  it("draws with the current design tokens", () => {
    expect(
      read(SHARE_TOKENS_SWIFT_PATH),
      "Run `pnpm --filter @tangow/mobile generate:share-tokens` after changing a token.",
    ).toBe(shareTokensSwift());
  });

  // A renamed key fails silently: the extension just asks to sign in.
  it("reads the session from the keychain keys the app writes", () => {
    const client = read("targets/share/ShareClient.swift");
    for (const [file, key] of [
      ["lib/session.ts", "rakazo.session_token"],
      ["lib/api.ts", "rakazo.api_base"],
      ["lib/api.ts", "rakazo.space_id"],
      ["lib/access-store.ts", "rakazo.cf_access"],
    ] as const) {
      expect(read(file)).toContain(`"${key}"`);
      expect(client).toContain(`"${key}"`);
    }
  });
});
