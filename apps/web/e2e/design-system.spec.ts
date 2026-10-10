// Needs the Vite dev server: the fixture is served from source and is not a build entry.

import { captureScreenshot } from "./helpers";
import { expect, test } from "./test";

const PRIMITIVES = [
  "framed-block",
  "surface",
  "message-row",
  "user-bubble",
  "interstitial",
  "stacked-avatars",
  "working-line",
  "hover-pill",
  "composer-shell",
  "reasoning-disclosure",
];

test("the design-system kitchen sink renders every primitive light and dark", async ({
  page,
}, testInfo) => {
  await page.goto("/e2e/fixtures/design-system.html");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));

  for (const slot of PRIMITIVES) {
    await expect(page.locator(`[data-slot="${slot}"]`).first()).toBeVisible();
  }

  // The thread frames exactly one thing, and it is not a message.
  await expect(page.locator('[data-slot="message-row"]').first()).not.toHaveClass(/shadow-/);
  await expect(page.locator('[data-slot="framed-block"]').first()).toHaveClass(/shadow-card/);
  // An unframed card is a fill and a hairline.
  await expect(page.locator('[data-slot="surface"]').first()).not.toHaveClass(/shadow-/);

  // The hover pill is absent until the row is hovered or focused.
  const pill = page.locator('[data-slot="hover-pill"]').first();
  await expect(pill).toHaveClass(/opacity-0/);
  await expect(pill).toHaveCSS("opacity", "0");
  await page.locator('[data-slot="message-row"]').first().hover();
  await expect(pill).toHaveCSS("opacity", "1");

  // Answering a block settles it: the controls and the actions are gone even
  // though the fixture still passes both.
  const answered = page.locator('[data-slot="framed-block"][data-answered="true"]');
  await expect(answered.locator('[data-slot="framed-block-answered"]')).toBeVisible();
  await expect(answered.locator('[data-slot="framed-block-actions"]')).toHaveCount(0);
  await expect(answered.locator('[data-slot="framed-block-body"]')).toHaveCount(0);
  await expect(answered.locator("button")).toHaveCount(0);

  // A decision hugs the right edge, dismiss then secondary then primary; a list
  // of answers stays on the left.
  const decision = page.locator('[data-slot="framed-block-actions"][data-align="end"]').first();
  const decisionButtons = await decision.locator("button").evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      return { text: node.textContent, left: box.left, right: box.right };
    }),
  );
  expect(decisionButtons.map((button) => button.text)).toEqual([
    "Deny",
    "Always allow this tool",
    "Allow once",
  ]);
  const decisionBox = (await decision.boundingBox())!;
  expect(decisionButtons[2]!.right).toBeCloseTo(decisionBox.x + decisionBox.width - 14, 0);
  expect(decisionButtons[0]!.left).toBeGreaterThan(decisionBox.x + decisionBox.width / 3);

  const answers = page.locator('[data-slot="framed-block-actions"][data-align="start"]').first();
  const answersBox = (await answers.boundingBox())!;
  const otherAnswer = (await answers.locator("button").boundingBox())!;
  expect(otherAnswer.x).toBeCloseTo(answersBox.x + 14, 0);

  // A named stack is readable; an unnamed one is decoration.
  await expect(page.locator('[data-slot="stacked-avatars"][role="img"]').first()).toHaveAttribute(
    "aria-label",
    "Maya and Atlas",
  );
  await expect(
    page.locator('[data-slot="stacked-avatars"]:not([role="img"])').first(),
  ).toHaveAttribute("aria-hidden", "true");

  // A consequential action says so before it is pressed.
  await expect(page.locator('[data-consequential="true"]').first()).toBeVisible();

  // Only the last reasoning step shimmers while the run lives.
  await expect(page.locator(".rk-shimmer")).toHaveCount(3);

  // The primitives' plain classes sit in a layer a utility can beat, so a
  // caller's `className` still decides.
  await expect(page.getByTestId("shimmer-override")).toHaveCSS("color", "rgb(220, 38, 38)");

  await page.mouse.move(0, 0);
  await captureScreenshot(page, testInfo, "design-system-light");

  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(12, 12, 14)");
  await captureScreenshot(page, testInfo, "design-system-dark");
});

test("a long working line is cut with an ellipsis, never widening a phone screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/e2e/fixtures/design-system.html");

  const row = page.getByTestId("working-line-long");
  await expect(row).toBeVisible();
  const label = row.locator('[data-slot="working-line-label"]');
  // The label overflows its own box (so the ellipsis shows) while the page stays phone-wide.
  expect(await label.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await expect(row.locator('[data-slot="working-line-elapsed"]')).toBeInViewport();
});
