import { expect, it } from "vitest";
import { DEVELOPMENT_CASES } from "./cases.js";
import { validateCorpus } from "./corpus.js";
import { HOLDOUT_CASES } from "./holdout.js";

it("rejects cross-split groups and an explicit false hint without relying on corpus order", () => {
  const development = DEVELOPMENT_CASES.map((c, index) =>
    index === 0 ? { ...c, annotation: { ...c.annotation, group: "shared-regression" } } : c,
  );
  const holdout = HOLDOUT_CASES.map((c, index) =>
    index === 0
      ? {
          ...c,
          id: "regression/hinted",
          annotation: { ...c.annotation, group: "shared-regression" },
          input: { ...c.input, tool: { ...c.input.tool, readOnly: false } },
        }
      : c,
  );

  expect(validateCorpus({ development, holdout })).toEqual([
    "Group shared-regression appears in both splits",
    "Holdout case regression/hinted is readonly_hint_false, not eligible",
  ]);
});

it("rejects a missing development split", () => {
  expect(validateCorpus({ development: [], holdout: HOLDOUT_CASES })).toContain(
    "development has 0 cases, expected 160",
  );
});

it("rejects model-eligible cases that already require outbound approval", () => {
  let replaced = false;
  const development = DEVELOPMENT_CASES.map((c) => {
    if (replaced || c.annotation.expected.label !== "consequential") return c;
    replaced = true;
    return {
      ...c,
      id: "regression/send",
      annotation: { ...c.annotation, gatedElsewhere: null },
      input: {
        publicName: "fixture_send_email",
        tool: {
          name: "fixture_send_email",
          description: "Send an email to an external recipient.",
          inputSchema: { type: "object" },
        },
        args: { to: "someone@example.com", body: "Hello" },
      },
    };
  });

  expect(validateCorpus({ development, holdout: HOLDOUT_CASES })).toEqual([
    "Case regression/send requires outbound approval but is marked model-eligible",
  ]);
});
