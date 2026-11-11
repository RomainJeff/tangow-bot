import { SessionEntrySchema } from "@tangow/contracts";
import { projectThreadView } from "@tangow/core";
import { describe, expect, it, vi } from "vitest";
import type { MessageItem } from "../../lib/thread-items";

// vitest doesn't run the lingui macro transform: same passthrough as the other web tests.
vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: String }) }));

import { messageIdOf } from "./use-thread-view";

describe("messageIdOf", () => {
  it("resolves every message of an image stack, not only its newest", () => {
    const entries = ["a", "b", "c"].map((name, seq) =>
      SessionEntrySchema.parse({
        id: `img-${seq}`,
        sessionId: "ses_images",
        seq,
        parentId: seq === 0 ? null : `img-${seq - 1}`,
        ts: `2026-10-10T09:00:0${seq}.000Z`,
        botId: "bot_ada",
        type: "bot.text",
        payload: {
          blocks: [
            {
              kind: "image",
              artifactId: `art_${name}`,
              mimeType: "image/png",
              name: `${name}.png`,
            },
          ],
        },
      }),
    );
    const view = projectThreadView(entries, { imageStacks: true });
    const message = (id: string) => ({ kind: "message", id }) as MessageItem;

    expect(["img-0", "img-1", "img-2"].map((id) => messageIdOf(view, message(id)))).toEqual([
      "img-0",
      "img-1",
      "img-2",
    ]);
  });
});
