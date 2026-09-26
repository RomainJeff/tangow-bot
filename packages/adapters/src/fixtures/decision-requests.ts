import type { DecisionRequest } from "@rakazo/adapter-kit";

/** Fixture-page requests for the fake adapters in the conformance suite. */
export const decisionConformanceRequests = {
  target: {
    state: { page: { url: "https://example.test/", title: "Reports" } },
    questions: {
      target: {
        type: "choice",
        instructions: "Which element matches: download CSV?",
        options: {
          e1: 'link "Download"',
          e2: 'link "Download CSV"',
          none: "no listed element matches",
        },
      },
    },
  },
  signin: {
    state: "The page shows a sign-in form.",
    questions: { signin: { type: "noul", instructions: "Is this a sign-in page?" } },
  },
  sure: {
    state: "Order placed.",
    questions: {
      sure: {
        type: "score",
        instructions: "How settled is the page?",
        levels: ["no", "some", "yes"],
      },
    },
  },
} satisfies Record<string, DecisionRequest>;
