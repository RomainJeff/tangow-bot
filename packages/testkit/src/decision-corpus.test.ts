import { describe, expect, it } from "vitest";
import type { DecisionCase } from "./decision-corpus.js";
import { buildDecisionRequests, loadDecisionCorpus, parseDecisionCase } from "./decision-corpus.js";

const targetCase: DecisionCase = {
  id: "inline-target",
  family: "distractors",
  lang: "fr",
  kind: "click",
  page: {
    url: "https://boutique.test/facture",
    title: "Commande",
    html: '<button>Télécharger</button><a href="/f">Télécharger</a><input aria-label="Recherche"/>',
  },
  target: "la facture",
  expected: { role: "link", name: "Télécharger" },
};

const outcomeCase: DecisionCase = {
  id: "inline-outcome",
  family: "outcome",
  lang: "en",
  before: { url: "https://shop.test/", title: "Home", html: '<a href="/account">Account</a>' },
  after: {
    url: "https://shop.test/login",
    title: "Sign in",
    html: '<input aria-label="Email"/><button>Sign in</button>',
  },
  action: { kind: "click", role: "link", name: "Account" },
  expected: "auth",
};

describe("decision corpus", () => {
  it("builds every committed case, in both languages, with its label among the offered options", async () => {
    const corpus = loadDecisionCorpus();
    const built = await buildDecisionRequests(corpus);
    expect(built).toHaveLength(corpus.length);
    const again = await buildDecisionRequests(corpus);
    expect(again.map((item) => item.requestHash)).toEqual(built.map((item) => item.requestHash));
    const ids = new Set(corpus.map((item) => item.id));
    for (const item of corpus) {
      if (item.family !== "outcome" && item.targetLang) continue;
      const twin = item.id.replace(/-(fr|en)$/, (_, lang) => (lang === "fr" ? "-en" : "-fr"));
      expect(ids.has(twin), `${item.id} has no ${twin}`).toBe(true);
    }
  });

  it("refuses a page or a link outside .test", () => {
    const outside = { ...targetCase, page: { ...targetCase.page, url: "https://example.com/" } };
    expect(() => parseDecisionCase(outside)).toThrow(/\.test/);
    const link = {
      ...targetCase,
      page: { ...targetCase.page, html: '<a href="https://example.com/x">x</a>' },
    };
    expect(() => parseDecisionCase(link)).toThrow(/\.test/);
  });

  it("builds the exact requests browser_act sends for a target and its verification", async () => {
    const [target, outcome] = await buildDecisionRequests([targetCase, outcomeCase]);
    // Written out by hand: a change to the production request must show up here,
    // because every recording keyed by the old request hash goes stale with it.
    expect(target!.request).toEqual({
      state: { url: "https://boutique.test/facture", title: "Commande" },
      questions: {
        target: {
          type: "choice",
          instructions: "Which element matches: la facture? Answer none if no listed element does.",
          options: {
            e1: 'button "Télécharger"',
            e2: 'link "Télécharger"',
            none: "no listed element matches",
          },
        },
      },
    });
    expect(target!.expectedKey).toBe("e2");
    expect(outcome!.request).toEqual({
      state: {
        action: { kind: "click", role: "link", name: "Account" },
        before: { url: "https://shop.test/", title: "Home", elements: 1 },
        after: { url: "https://shop.test/login", title: "Sign in", elements: 2 },
        added: ['textbox "Email"', 'button "Sign in"'],
        removed: ['link "Account"'],
      },
      questions: {
        outcome: {
          type: "choice",
          instructions: "What did the action produce?",
          options: {
            landed: "the page changed as the action intended",
            dialog: "a dialog, modal, or popup opened",
            error: "an error or validation message appeared",
            auth: "the page asks to sign in, solve a challenge, or prove the user is human",
            unchanged: "nothing visible changed",
          },
        },
      },
    });
  });
});
