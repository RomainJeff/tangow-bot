import { expect, it } from "vitest";
import { messageDigest } from "./shared.js";

it("digests message blocks independently of key order, as Postgres JSONB may reorder them", () => {
  expect(messageDigest([{ kind: "text", text: "hi" }])).toBe(
    messageDigest([{ text: "hi", kind: "text" }]),
  );
  expect(messageDigest([{ kind: "text", text: "hi" }])).not.toBe(
    messageDigest([{ kind: "text", text: "hey" }]),
  );
});
