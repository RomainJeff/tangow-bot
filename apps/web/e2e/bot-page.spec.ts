// Needs the Vite dev server: the fixture is served from source and is not a build entry.
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const FIXTURE = "/e2e/fixtures/bot-page.html";

const STATES = [
  { name: "settings", query: "tab=settings" },
  { name: "routines", query: "tab=routines" },
  { name: "knowledge", query: "tab=knowledge" },
  { name: "instructions", query: "tab=settings&detail=instructions" },
  { name: "description", query: "tab=settings&detail=description" },
  { name: "model", query: "tab=settings&detail=model" },
  { name: "voice", query: "tab=settings&detail=voice" },
  { name: "busy", query: "tab=settings&busy=1" },
  { name: "first", query: "first=1" },
] as const;

for (const theme of ["light", "dark"] as const) {
  for (const state of STATES) {
    test(`bot page ${state.name}, ${theme}`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${FIXTURE}?${state.query}&theme=${theme}`);
      const botPage = page.getByTestId("bot-page");
      await expect(botPage).toBeVisible();
      await expect(botPage).not.toHaveAttribute("aria-busy", "true");
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      if (state.name === "knowledge") {
        await expect(page.getByTestId("bot-knowledge-memory")).toContainText("MEMORY.md");
      }
      await captureScreenshot(page, testInfo, `bot-page-${state.name}-${theme}`);
    });
  }
}

test("the tabs are one tab stop, moved with the arrow keys", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=routines`);
  const tabs = page.getByRole("tablist");
  await expect(tabs.getByRole("tab")).toHaveText(["Routines", "Knowledge", "Settings"]);
  await tabs.getByRole("tab", { name: "Routines" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.getByRole("tab", { name: "Knowledge" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(tabs.getByRole("tab", { name: "Knowledge" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});

test("instructions save on blur, say so, and keep the text when a save fails", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=settings&detail=instructions`);
  const panel = page.getByTestId("side-panel");
  await expect(panel).toHaveAttribute("data-size", "wide");
  const field = page.getByTestId("bot-instructions");
  const meta = page.locator('[data-slot="save-meta"]').first();

  await field.fill("Flag invoices the moment they land.");
  await field.blur();
  await expect(meta).toHaveText("Saving…");
  await expect(meta).toHaveText(/^Saved \d/);

  await page.getByTestId("fixture-fail-saves").check();
  await field.fill("Flag invoices and contracts.");
  await field.blur();
  await expect(meta).toContainText("Could not save");
  await expect(field).toHaveValue("Flag invoices and contracts.");
  await page.getByTestId("fixture-fail-saves").uncheck();
  await meta.getByRole("button", { name: "Retry" }).click();
  await expect(meta).toHaveText(/^Saved \d/);

  // Retry leaves with its button, so Escape is pressed from the field again.
  await field.focus();
  await page.keyboard.press("Escape");
  await expect(panel).toHaveAttribute("data-size", "default");
});

test("clearing the instructions asks first", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=settings&detail=instructions`);
  const field = page.getByTestId("bot-instructions");
  await field.fill("");
  await field.blur();
  const dialog = page.getByRole("alertdialog", { name: "Clear instructions?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(field).not.toHaveValue("");
});

test("the computer cannot change while the bot works", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=settings&busy=1`);
  const settings = page.getByTestId("bot-settings");
  await expect(settings.getByText("Available when Scout is idle")).toBeVisible();
  await expect(settings.getByRole("button", { name: "Team", exact: true })).toBeDisabled();
});

test("a refused computer change turns back and says why", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=settings&refuse=1`);
  const settings = page.getByTestId("bot-settings");
  const team = settings.getByRole("button", { name: "Team", exact: true });
  const own = settings.getByRole("button", { name: "Private", exact: true });
  await expect(own).toHaveAttribute("aria-pressed", "true");
  await team.click();
  await expect(
    settings.getByText("Wait for this bot to finish before changing its computer."),
  ).toBeVisible();
  await expect(own).toHaveAttribute("aria-pressed", "true");
});

test("a bot with nothing set up shows its first steps instead of tabs", async ({ page }) => {
  await page.goto(`${FIXTURE}?first=1`);
  const botPage = page.getByTestId("bot-page");
  await expect(botPage.getByText("Not awake yet")).toBeVisible();
  await expect(botPage.getByRole("tablist")).toHaveCount(0);
  await expect(botPage.getByLabel("Title", { exact: true })).toHaveAttribute(
    "placeholder",
    "What it does, in one line",
  );
  await botPage.getByRole("button", { name: "Write", exact: true }).click();
  await page.getByTestId("bot-instructions").fill("Close the books every first Monday.");
  await botPage.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(botPage.getByRole("tablist")).toBeVisible();
});

test("Knowledge shows memory, files and skills", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=knowledge`);
  const knowledge = page.getByTestId("bot-knowledge");
  await expect(knowledge.getByTestId("bot-knowledge-memory")).toContainText("MEMORY.md");
  await expect(knowledge).toContainText("inbox-report.md");
  await expect(knowledge.getByTestId("bot-skills")).toContainText("inbox-triage");
});
