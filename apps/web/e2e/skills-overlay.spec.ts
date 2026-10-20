import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { expect, test } from "./test";

test("skills overlay: user and built-in skills, search, desktop and phone", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `skills-overlay-${stamp}@rakazo.test`, "password12", "Skills Overlay");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  // Keep a user skill beside the built-in catalog.
  await rpc(page, "agentSkills/create", {
    name: "Daily standup",
    description: "Prepare a concise standup update from recent work.",
    body: "1. Summarize wins.\n2. List blockers.",
  });

  await page.getByTestId("open-customize").click();
  await page.getByTestId("customize-nav-skills").click();
  const overlay = page.getByRole("dialog");
  await expect(overlay.getByRole("heading", { name: "Skills" })).toBeVisible();
  await expect(overlay.getByRole("tab")).toHaveCount(0);
  await expect(overlay.getByRole("button", { name: /Interrogate/ })).toBeVisible();
  await expect(overlay.getByRole("button", { name: /Daily standup/ })).toBeVisible();
  await overlay.getByTestId("bot-knowledge-skill-search").fill("zzz-no-match");
  await expect(overlay.getByRole("button", { name: /Daily standup/ })).toHaveCount(0);
  await expect(overlay.getByText("No skills match")).toBeVisible();
  await overlay.getByTestId("bot-knowledge-skill-search").fill("standup");
  await expect(overlay.getByRole("button", { name: /Daily standup/ })).toBeVisible();
  await overlay.getByTestId("bot-knowledge-skill-search").fill("");
  await captureScreenshot(page, testInfo, "90-skills-desktop");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(overlay.getByRole("button", { name: /Daily standup/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "91-skills-phone");

  await overlay.getByLabel("Close skills").click();
  await expect(overlay).toHaveCount(0);
});
