import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

// The in-page helpers of the live page browser, run as Chrome runs them in the isolated world.
const script = readFileSync(
  new URL("../../../infra/sandboxes/computer/tangow-page-browser", import.meta.url),
  "utf8",
);
const helpers = script.slice(
  script.indexOf('EVAL_HELPERS = r"""') + 'EVAL_HELPERS = r"""'.length,
  script.indexOf('"""', script.indexOf('EVAL_HELPERS = r"""') + 20),
);

type Helper = {
  snapshot(): { elements: Array<{ ref: string; name: string; password?: true }> };
  signIn(
    origin: string,
    usernameRef: string | null,
    username: string,
    passwordRef: string | null,
    password: string,
  ): unknown;
};

function page(url: string) {
  const dom = new JSDOM(
    `<input aria-label="Email" type="email"><input aria-label="Name"><input aria-label="Password" type="password">`,
    { url, runScripts: "outside-only", pretendToBeVisual: true },
  );
  const window = dom.window;
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ width: 10, height: 10 }) as DOMRect;
  window.eval(helpers);
  const browser = (window as unknown as { __tangowPageBrowser: Helper }).__tangowPageBrowser;
  const refs = Object.fromEntries(browser.snapshot().elements.map((el) => [el.name, el.ref]));
  const value = (label: string) =>
    (window.document.querySelector(`[aria-label="${label}"]`) as HTMLInputElement).value;
  return { browser, refs, value };
}

describe("page browser signIn", () => {
  it("fills the username and the password on the saved site", () => {
    const { browser, refs, value } = page("https://example.test/login");
    browser.signIn("https://example.test", refs.Email!, "me", refs.Password!, "fake-password");
    expect([value("Email"), value("Password")]).toEqual(["me", "fake-password"]);
  });

  it("refuses another site, even a subdomain, without filling", () => {
    const { browser, refs, value } = page("https://login.example.test/");
    expect(() =>
      browser.signIn("https://example.test", refs.Email!, "me", refs.Password!, "fake-password"),
    ).toThrow("not the saved site");
    expect(value("Password")).toBe("");
  });

  it("refuses a password ref that is not a password field", () => {
    const { browser, refs, value } = page("https://example.test/");
    expect(() =>
      browser.signIn("https://example.test", null, "", refs.Name!, "fake-password"),
    ).toThrow("not a password field");
    expect(value("Name")).toBe("");
  });
});
