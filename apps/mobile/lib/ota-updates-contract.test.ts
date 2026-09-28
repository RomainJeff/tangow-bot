import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("mobile over-the-air updates", () => {
  it("fetches updates from the Expo project the app is built and published with", () => {
    // `eas update` publishes to extra.eas.projectId; an installed app only ever reads
    // updates.url. When the two differ, the app never receives its own updates and
    // takes whatever another project ships to the same channel instead.
    const { expo } = JSON.parse(readFileSync(resolve(mobileRoot, "app.json"), "utf8"));
    expect(expo.updates.url).toBe(`https://u.expo.dev/${expo.extra.eas.projectId}`);
  });
});
