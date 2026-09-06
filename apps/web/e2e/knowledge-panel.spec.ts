import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  realSandboxTimeout,
  rpc,
  signup,
} from "./helpers";

test("memory and skills are readable and editable in the app", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const userName = `Knowledge ${stamp}`;
  await signup(page, `knowledge-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  // Ask the agent for a working file up front so the Files tab has something
  // real to show by the time memory and skills are done.
  const chiefId = activeBotId(page);
  const fileMarker = `file-${stamp}`;
  await page
    .getByPlaceholder(/Message/)
    .fill(`write a file in your home called notes/result.csv that says ${fileMarker}`);
  await page.keyboard.press("Enter");

  // Space-wide documents live in the Memory settings overlay. Open that before
  // bot settings so the Knowledge Memory tab cannot steal this click.
  await page.getByRole("button", { name: new RegExp(userName) }).click();
  await page.getByRole("button", { name: "Memory", exact: true }).click();
  await expect(page.getByLabel("Close memory settings")).toBeVisible();
  const spaceDocs = page.getByTestId("space-memory-documents");
  await expect(spaceDocs.getByText("Shared documents")).toBeVisible();
  const memoryRow = spaceDocs.getByRole("button", { name: /MEMORY\.md/ });
  await expect(memoryRow).toBeVisible();
  await memoryRow.click();
  const docEditor = spaceDocs.locator("textarea");
  const marker = `Edited in e2e ${stamp}`;
  await docEditor.fill(`# Memory\n\n${marker}\n`);
  await captureScreenshot(page, testInfo, "83-space-memory-editor");
  await spaceDocs.getByRole("button", { name: "Save", exact: true }).click();
  await expect(spaceDocs.getByText("rev 2")).toBeVisible();

  // The save persisted: reopen the document and find the marker.
  await memoryRow.click();
  await expect(docEditor).toHaveValue(new RegExp(marker));
  await captureScreenshot(page, testInfo, "84-space-memory-saved");
  await page.getByLabel("Close memory settings").click();
  await expect(page.getByLabel("Close memory settings")).toHaveCount(0);

  // The bot's Knowledge section lives under Advanced in its settings panel.
  await page
    .locator("main")
    .getByRole("button", { name: /^Chief/ })
    .click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await settings.getByText("Advanced", { exact: true }).click();
  const knowledge = settings.getByTestId("bot-knowledge");
  await expect(knowledge).toBeVisible();
  await expect(knowledge.getByText("Knowledge", { exact: true })).toBeVisible();

  // Bot creation seeds MEMORY.md (`# Chief`); edit it and assert the revision bumps.
  const botMemory = knowledge.getByTestId("bot-knowledge-memory");
  const botMemoryRow = botMemory.getByRole("button", { name: /MEMORY\.md/ });
  await expect(botMemoryRow).toBeVisible();
  await botMemoryRow.click();
  const botDocEditor = botMemory.locator("textarea");
  await expect(botDocEditor).toHaveValue(/# Chief/);
  const botMarker = `Bot memory e2e ${stamp}`;
  await botDocEditor.fill(`# Chief\n\n${botMarker}\n`);
  await captureScreenshot(page, testInfo, "80-knowledge-bot-memory");
  await botMemory.getByRole("button", { name: "Save", exact: true }).click();
  await expect(botMemory.getByText("rev 2")).toBeVisible();
  await botMemoryRow.click();
  await expect(botDocEditor).toHaveValue(new RegExp(botMarker));
  await botMemory.getByRole("button", { name: "Cancel", exact: true }).click();

  // Skills: create one through the editor, reopen it, edit, then delete it.
  // Builtin catalog is currently empty; user skills still cover create/edit/delete.
  await knowledge.getByRole("button", { name: "Skills", exact: true }).click();
  await knowledge.getByRole("button", { name: "New skill", exact: true }).click();
  const editor = knowledge.locator("textarea");
  await editor.fill(
    [
      "---",
      "name: greet-politely",
      "description: Say hello before anything else.",
      "---",
      "",
      "Always open with a greeting.",
    ].join("\n"),
  );
  await captureScreenshot(page, testInfo, "81-knowledge-skill-editor");
  await knowledge.getByRole("button", { name: "Save", exact: true }).click();
  const skillRow = knowledge.getByRole("button", { name: /greet-politely/ });
  await expect(skillRow).toBeVisible();
  await expect(knowledge.getByText("Say hello before anything else.")).toBeVisible();
  await captureScreenshot(page, testInfo, "82-knowledge-skill-listed");

  // Import: a plain-text .skill lands in the list like a hand-made skill.
  await knowledge.getByTestId("bot-knowledge-skill-import").setInputFiles({
    name: "imported.skill",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(
      ["---", "name: imported-skill", "description: Came from a file.", "---", "", "Body."].join(
        "\n",
      ),
    ),
  });
  await expect(knowledge.getByRole("button", { name: /imported-skill/ })).toBeVisible();

  // Scoping: a hand-made skill is visible to every agent; the agent's own switch
  // writes a per-bot override that hides it from Chief's catalog only.
  type CatalogEntry = { id: string; name: string; availability: string; visibleBotIds: string[] };
  const listFor = (botId?: string) =>
    rpc<CatalogEntry[]>(page, "agentSkills/list", botId ? { botId } : undefined);
  const before = (await listFor()).find((entry) => entry.name === "greet-politely");
  expect(before?.availability).toBe("all");
  expect(before?.visibleBotIds).toContain(chiefId);

  const skillCard = knowledge
    .getByTestId("bot-knowledge-skill")
    .filter({ hasText: "greet-politely" });
  const chiefSwitch = skillCard.getByRole("switch", { name: "greet-politely" });
  await expect(chiefSwitch).toHaveAttribute("aria-checked", "true");
  await chiefSwitch.click();
  await expect(chiefSwitch).toHaveAttribute("aria-checked", "false");
  await captureScreenshot(page, testInfo, "82b-knowledge-skill-scoped");
  await expect
    .poll(async () => (await listFor(chiefId)).some((entry) => entry.name === "greet-politely"))
    .toBe(false);
  expect((await listFor()).some((entry) => entry.name === "greet-politely")).toBe(true);
  await chiefSwitch.click();
  await expect(chiefSwitch).toHaveAttribute("aria-checked", "true");
  await expect
    .poll(async () => (await listFor(chiefId)).some((entry) => entry.name === "greet-politely"))
    .toBe(true);

  // A skill disabled for every agent cannot be switched on from here.
  await rpc(page, "agentSkills/setAccess", {
    skillId: before?.id,
    availability: "disabled",
  });
  await knowledge.getByRole("button", { name: "Memory", exact: true }).click();
  await knowledge.getByRole("button", { name: "Skills", exact: true }).click();
  await expect(chiefSwitch).toHaveAttribute("aria-checked", "false");
  await expect(chiefSwitch).toBeDisabled();
  await expect(skillCard.getByText("Disabled for all agents in Skills")).toBeVisible();
  await rpc(page, "agentSkills/setAccess", { skillId: before?.id, availability: "all" });

  await skillRow.click();
  await expect(editor).toHaveValue(/Always open with a greeting/);
  await editor.fill(
    [
      "---",
      "name: greet-politely",
      "description: Say hello before anything else.",
      "---",
      "",
      "Open with a warm greeting.",
    ].join("\n"),
  );
  await knowledge.getByRole("button", { name: "Save", exact: true }).click();
  await skillRow.click();
  await expect(editor).toHaveValue(/warm greeting/);
  await knowledge.getByRole("button", { name: "Delete", exact: true }).click();
  await knowledge.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(skillRow).toBeHidden();

  // Files: the agent's working folder, browsable down to a readable file.
  await expect
    .poll(
      async () => {
        const entries = await rpc<Array<{ path: string }>>(page, "computer/files", {
          botId: chiefId,
          path: "",
        });
        return entries.some((entry) => entry.path === "notes");
      },
      {
        timeout: realSandboxTimeout(90_000, 20_000),
        message: "the agent must finish writing notes/result.csv",
      },
    )
    .toBe(true);

  await knowledge.getByRole("button", { name: "Files", exact: true }).click();
  const files = knowledge.getByTestId("bot-knowledge-files");
  const notesRow = files.getByRole("button", { name: "notes/", exact: true });
  await expect(notesRow).toBeVisible();
  await notesRow.click();
  const csvRow = files.getByRole("button", { name: /result\.csv/ });
  await expect(csvRow).toBeVisible();
  await captureScreenshot(page, testInfo, "85-knowledge-files-list");
  await csvRow.click();
  await expect(files.locator("textarea")).toHaveValue(new RegExp(fileMarker));
  await expect(files.getByRole("button", { name: "Download", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "86-knowledge-files-preview");
});
