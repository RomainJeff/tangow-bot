import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  realSandboxTimeout,
  rpc,
  signup,
} from "./helpers";

test("skills and files remain available in the agent knowledge panel", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Knowledge ${stamp}`;
  await signup(page, `knowledge-${stamp}@rakazo.test`, "password12", userName);
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);

  // Ask the agent for a working file up front so the Files tab has something
  // real to show by the time skills are done. Memory has its own journey spec.
  const chiefId = activeBotId(page);
  const fileMarker = `file-${stamp}`;
  await page
    .getByPlaceholder(/Message/)
    .fill(`write a file in your home called notes/result.csv that says ${fileMarker}`);
  await page.keyboard.press("Enter");

  // The bot's Knowledge section lives under Advanced in its settings panel.
  await page
    .locator("main")
    .getByRole("button", { name: /^Chief/ })
    .click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await settings.getByText("Advanced", { exact: true }).click();
  /** Remount the settings panel so its sections refetch after an out-of-band RPC. */
  const reopenAdvanced = async () => {
    await page.reload();
    await page
      .locator("main")
      .getByRole("button", { name: /^Chief/ })
      .click();
    await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    await settings.getByText("Advanced", { exact: true }).click();
  };
  const knowledge = settings.getByTestId("bot-knowledge");
  await expect(knowledge).toBeVisible();
  await expect(knowledge.getByText("Knowledge", { exact: true })).toBeVisible();

  // Skills: its own section next to Knowledge. Create one through the editor,
  // reopen it, edit, then delete it. Builtin catalog is currently empty; user
  // skills still cover create/edit/delete.
  const skillsSection = settings.getByTestId("bot-skills");
  await expect(skillsSection.getByText("Skills", { exact: true })).toBeVisible();
  await skillsSection.getByRole("button", { name: "New skill", exact: true }).click();
  const editor = skillsSection.locator("textarea");
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
  await skillsSection.getByRole("button", { name: "Save", exact: true }).click();
  const skillRow = skillsSection.getByRole("button", { name: /greet-politely/ });
  await expect(skillRow).toBeVisible();
  await expect(skillsSection.getByText("Say hello before anything else.")).toBeVisible();
  await captureScreenshot(page, testInfo, "82-knowledge-skill-listed");
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("/");
  await expect(
    page.getByRole("button", { name: "Skill greet-politely", exact: true }),
  ).toBeVisible();
  await composer.fill("");

  // Import: a plain-text .skill lands in the list like a hand-made skill.
  await skillsSection.getByTestId("bot-knowledge-skill-import").setInputFiles({
    name: "imported.skill",
    mimeType: "application/octet-stream",
    buffer: Buffer.from(
      ["---", "name: imported-skill", "description: Came from a file.", "---", "", "Body."].join(
        "\n",
      ),
    ),
  });
  await expect(skillsSection.getByRole("button", { name: /imported-skill/ })).toBeVisible();

  // Scoping: a hand-made skill is visible to every agent; the agent's own switch
  // writes a per-bot override that hides it from Chief's catalog only.
  type CatalogEntry = { id: string; name: string; availability: string; visibleBotIds: string[] };
  const listFor = (botId?: string) =>
    rpc<CatalogEntry[]>(page, "agentSkills/list", botId ? { botId } : undefined);
  const before = (await listFor()).find((entry) => entry.name === "greet-politely");
  expect(before?.availability).toBe("all");
  expect(before?.visibleBotIds).toContain(chiefId);

  const skillCard = skillsSection
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

  // A skill disabled for every agent is not installable, so it leaves this list.
  // The section reads the catalog on mount, hence the reopen.
  await rpc(page, "agentSkills/setAccess", {
    skillId: before?.id,
    availability: "disabled",
  });
  await reopenAdvanced();
  await expect(skillCard).toHaveCount(0);
  await rpc(page, "agentSkills/setAccess", { skillId: before?.id, availability: "all" });
  await reopenAdvanced();
  await expect(skillCard).toHaveCount(1);

  // A provider-owned skill uses the same viewer without mutation controls.
  await page.route(
    "**/rpc/agentSkills/get",
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, json: { ...body.json, readOnly: true, source: "plugin" } },
      });
    },
    { times: 1 },
  );
  await skillRow.click();
  await expect(editor).toHaveAttribute("readonly", "");
  await expect(skillsSection.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(skillsSection.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await skillsSection.getByRole("button", { name: "Close", exact: true }).click();
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
  let releaseSkillRefresh!: () => void;
  const skillRefreshGate = new Promise<void>((resolve) => {
    releaseSkillRefresh = resolve;
  });
  await page.route(
    "**/rpc/agentSkills/list",
    async (route) => {
      await skillRefreshGate;
      await route.continue();
    },
    { times: 1 },
  );
  await skillsSection.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(editor).toBeHidden();
    await expect(skillRow).toBeDisabled();
    await captureScreenshot(page, testInfo, "85-skill-refresh-pending");
  } finally {
    releaseSkillRefresh();
  }
  await skillRow.click();
  await expect(editor).toHaveValue(/warm greeting/);
  await skillsSection.getByRole("button", { name: "Delete", exact: true }).click();
  await skillsSection.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(skillRow).toBeHidden();
  await composer.fill("/");
  await expect(page.getByRole("button", { name: "Skill greet-politely", exact: true })).toHaveCount(
    0,
  );
  await composer.fill("");
  expect(await rpc<Array<{ name: string }>>(page, "agentSkills/list", {})).not.toContainEqual(
    expect.objectContaining({ name: "greet-politely" }),
  );

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
