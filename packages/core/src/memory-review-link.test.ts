import { describe, expect, it } from "vitest";
import { memoryReviewLink } from "./memory-review-link.js";

describe("memory review navigation", () => {
  it("translates web and native review paths without accepting another destination", () => {
    const target = { documentId: "memory-1", classificationId: "run-2" };
    expect(
      memoryReviewLink("/app/memory?collection=personal&memory=memory-1&classification=run-2"),
    ).toEqual(target);
    expect(memoryReviewLink("/memory-detail?documentId=memory-1&classificationId=run-2")).toEqual(
      target,
    );
    for (const url of [
      "https://external.test/app/memory?memory=memory-1&classification=run-2",
      "//external.test/app/memory?memory=memory-1&classification=run-2",
      "javascript:alert(1)",
      "/app/memory?memory=memory-1",
      "/app/memory?memory=..%2Fsecret&classification=run-2",
      "/app/memory?memory=memory-1&classification=run-2#outside",
    ])
      expect(memoryReviewLink(url)).toBeNull();
  });
});
