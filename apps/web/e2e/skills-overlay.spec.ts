import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";
import { expect, test } from "./test";

type Marketplace = { id: string; name: string; url: string };

test("skills overlay: tabs, marketplace URL validation, installed skills", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `skills-overlay-${stamp}@rakazo.test`, "password12", "Skills Overlay");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  // A user skill created up front so Installed has something to show.
  await rpc(page, "agentSkills/create", {
    name: "Daily standup",
    description: "Prepare a concise standup update from recent work.",
    body: "1. Summarize wins.\n2. List blockers.",
  });

  await page.getByTestId("open-customize").click();
  await page.getByTestId("customize-nav-skills").click();
  const overlay = page.getByRole("dialog");
  await expect(overlay.getByRole("heading", { name: "Skills" })).toBeVisible();
  await expect(page.getByTestId("skills-tab-installed")).toBeVisible();
  await expect(page.getByTestId("skills-tab-marketplaces")).toBeVisible();
  await expect(page.getByTestId("skills-tab-browse")).toBeVisible();

  // Installed: the user skill, plus search narrowing the list.
  await expect(overlay.getByRole("button", { name: /Daily standup/ })).toBeVisible();
  await overlay.getByTestId("bot-knowledge-skill-search").fill("zzz-no-match");
  await expect(overlay.getByRole("button", { name: /Daily standup/ })).toHaveCount(0);
  await expect(overlay.getByText("No skills match")).toBeVisible();
  await overlay.getByTestId("bot-knowledge-skill-search").fill("standup");
  await expect(overlay.getByRole("button", { name: /Daily standup/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "90-skills-installed");

  // Marketplaces: empty, and a non-GitHub URL is refused without creating a row.
  // No GitHub network call happens here: the URL is rejected before any fetch.
  expect(await rpc<Marketplace[]>(page, "marketplaces/list", {})).toEqual([]);
  await page.getByTestId("skills-tab-marketplaces").click();
  await expect(overlay.getByText("No marketplaces added yet.")).toBeVisible();
  await expect(overlay.getByText(/repository of skills/)).toBeVisible();
  await overlay.getByLabel("Marketplace URL").fill("https://gitlab.com/x/y");
  await overlay.getByRole("button", { name: "Add marketplace" }).click();
  await expect(overlay.getByText(/Only public GitHub repositories are supported/)).toBeVisible();
  await captureScreenshot(page, testInfo, "91-skills-marketplace-rejected");
  expect(await rpc<Marketplace[]>(page, "marketplaces/list", {})).toEqual([]);

  // Browse without a marketplace points back to the Marketplaces tab.
  await page.getByTestId("skills-tab-browse").click();
  await expect(overlay.getByText("Add a marketplace first.")).toBeVisible();

  await overlay.getByLabel("Close skills").click();
  await expect(overlay).toHaveCount(0);
});
