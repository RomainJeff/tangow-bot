// Needs the Vite dev server: the fixture is served from source and is not a build entry.

import { captureScreenshot } from "./helpers";
import { expect, test } from "./test";

const FIXTURE = "/e2e/fixtures/bot-page.html";

const STATES: Array<{ name: string; query: string; trigger?: RegExp }> = [
  { name: "settings", query: "tab=settings" },
  { name: "routines", query: "tab=routines" },
  { name: "routine", query: "tab=routines&detail=routine&routine=routine-2" },
  {
    name: "routine-trigger",
    query: "tab=routines&detail=routine&routine=routine-2",
    trigger: /^On a schedule/,
  },
  { name: "routine-new", query: "tab=routines&detail=routine-new" },
  { name: "knowledge", query: "tab=knowledge" },
  { name: "instructions", query: "tab=settings&detail=instructions" },
  { name: "description", query: "tab=settings&detail=description" },
  { name: "model", query: "tab=settings&detail=model" },
  { name: "voice", query: "tab=settings&detail=voice" },
  { name: "busy", query: "tab=settings&busy=1" },
];

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
      if (state.trigger) {
        await page.getByRole("button", { name: state.trigger }).click();
        await expect(page.getByRole("dialog")).toBeVisible();
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

test("Knowledge shows memory, files and skills", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=knowledge`);
  const knowledge = page.getByTestId("bot-knowledge");
  await expect(knowledge.getByTestId("bot-knowledge-memory")).toContainText("MEMORY.md");
  await expect(knowledge).toContainText("inbox-report.md");
  await expect(knowledge.getByTestId("bot-skills")).toContainText("inbox-triage");
});

test("a routine row says how its last run went, and its switch saves on its own", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?tab=routines`);
  const routines = page.getByTestId("bot-routines");
  await expect(routines).toContainText("3 routines · next in 14 hr.");
  await expect(routines.getByRole("button", { name: /Weekly digest/ })).toContainText(
    "Failed yesterday · Model error",
  );
  await expect(routines.getByRole("button", { name: /Invoice watch/ })).toContainText(
    "When a webhook fires · paused",
  );

  const toggle = routines.getByRole("switch", { name: "Active: Invoice watch" });
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(routines.locator('[data-slot="save-meta"]').last()).toHaveText(/^Saved \d/);
  await expect(routines.getByRole("button", { name: /Invoice watch/ })).not.toContainText("paused");
});

test("a routine opens wide, saves its name on blur, and edits a trigger in a dialog", async ({
  page,
}) => {
  await page.goto(`${FIXTURE}?tab=routines`);
  const panel = page.getByTestId("side-panel");
  await page.getByRole("button", { name: /Weekly digest/ }).click();
  await expect(panel).toHaveAttribute("data-size", "wide");

  const name = panel.getByLabel("Name", { exact: true });
  await name.fill("Monday digest");
  await name.blur();
  await expect(panel.locator('[data-slot="save-meta"]').first()).toHaveText(/^Saved \d/);

  await panel.getByRole("button", { name: /^On a schedule/ }).click();
  const editor = page.getByRole("dialog");
  await editor.getByLabel("How often").selectOption("Weekdays");
  await editor.getByRole("button", { name: "Done", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /^On a schedule/ })).toContainText(
    "Weekdays at 9:00 AM",
  );

  await panel.getByRole("button", { name: "Routines", exact: true }).click();
  await expect(panel).toHaveAttribute("data-size", "default");
  await expect(page.getByRole("button", { name: /Monday digest/ })).toBeFocused();
});

test("a new routine is only created once it has a trigger", async ({ page }) => {
  await page.goto(`${FIXTURE}?tab=routines&detail=routine-new`);
  const form = page.getByTestId("routine-create");
  await form.getByLabel("Name", { exact: true }).fill("Friday wrap-up");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(form.getByRole("alert")).toHaveText(
    "Add a schedule, webhook, GitHub, or message trigger",
  );

  await form.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "On a schedule" }).hover();
  await page.getByRole("menuitem", { name: "Every week", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page.getByTestId("routine-detail").getByLabel("Name", { exact: true })).toHaveValue(
    "Friday wrap-up",
  );
});

test("a routine's first webhook shows the bot's new key until Done", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${FIXTURE}?tab=routines&detail=routine&routine=routine-2`);
  const panel = page.getByTestId("side-panel");
  await panel.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "Webhook", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();

  const key = page.getByRole("dialog");
  await expect(key.getByText("Authorization: Bearer whsec_fixture_0000")).toBeVisible();
  await captureScreenshot(page, testInfo, "bot-page-routine-key");
  await key.getByRole("button", { name: "Done", exact: true }).click();
  await expect(key).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /^When a webhook fires/ })).toBeVisible();
});
