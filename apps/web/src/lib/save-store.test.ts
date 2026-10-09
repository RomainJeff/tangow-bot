import { ORPCError } from "@orpc/client";
import { expect, it } from "vitest";
import { saveFailureReason } from "./save-store";

it("shows the message the API wrote for a refusal it explains", () => {
  const reason = (code: string) =>
    saveFailureReason(new ORPCError(code, { message: "Add a run time for this one-shot." }));
  expect(reason("BAD_REQUEST")).toBe("Add a run time for this one-shot.");
  expect(reason("CONFLICT")).toBe("Add a run time for this one-shot.");
  expect(reason("FORBIDDEN")).toBe("Add a run time for this one-shot.");
  expect(reason("NOT_FOUND")).toBe("Add a run time for this one-shot.");
});

it("falls back to the translated label for oRPC's own English messages", () => {
  expect(saveFailureReason(new ORPCError("INTERNAL_SERVER_ERROR"))).toBe("");
  expect(saveFailureReason(new ORPCError("UNAUTHORIZED"))).toBe("");
  expect(saveFailureReason(new ORPCError("BAD_GATEWAY", { message: "fetch failed" }))).toBe("");
  expect(saveFailureReason(new ORPCError("FORBIDDEN"))).toBe("");
  expect(saveFailureReason(new ORPCError("NOT_FOUND"))).toBe("");
  expect(saveFailureReason(new TypeError("Failed to fetch"))).toBe("");
});
