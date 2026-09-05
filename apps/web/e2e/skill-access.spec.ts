import { expect, test } from "@playwright/test";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";

type CatalogEntry = { id: string; name: string; availability: string; visibleBotIds: string[] };

test("per-bot skill access via agentSkills.setAccess", async ({ page }) => {
  const stamp = Date.now();
  await signup(page, `skill-access-${stamp}@rakazo.test`, "password12", "Skill Access");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  const chiefId = activeBotId(page);

  const created = await rpc<{ id: string }>(page, "agentSkills/create", {
    name: "Daily standup",
    description: "Prepare a concise standup update from recent work.",
    body: "1. Summarize wins.\n2. List blockers.",
  });
  const listFor = (botId?: string) =>
    rpc<CatalogEntry[]>(page, "agentSkills/list", botId ? { botId } : undefined);
  const has = (entries: CatalogEntry[]) => entries.some((entry) => entry.id === created.id);

  // Default: visible to every bot.
  const before = (await listFor()).find((entry) => entry.id === created.id);
  expect(before?.availability).toBe("all");
  expect(before?.visibleBotIds).toContain(chiefId);
  expect(has(await listFor(chiefId))).toBe(true);

  // Exclude Chief: hidden from Chief's catalog, still in the full list.
  const excluded = await rpc<CatalogEntry>(page, "agentSkills/setAccess", {
    skillId: created.id,
    bot: { botId: chiefId, enabled: false },
  });
  expect(excluded.availability).toBe("all");
  expect(excluded.visibleBotIds).not.toContain(chiefId);
  expect(has(await listFor(chiefId))).toBe(false);
  expect(has(await listFor())).toBe(true);

  // Slash picker follows the active bot's catalog.
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill("/");
  const picker = page.getByTestId("slash-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByRole("button", { name: "Chat Settings" })).toBeVisible();
  await expect(picker.getByRole("button", { name: "Skill Daily standup" })).toHaveCount(0);
  await composer.fill("");

  // Selected + explicit include: visible to Chief again.
  const selected = await rpc<CatalogEntry>(page, "agentSkills/setAccess", {
    skillId: created.id,
    availability: "selected",
  });
  expect(selected.availability).toBe("selected");
  expect(selected.visibleBotIds).not.toContain(chiefId);
  const included = await rpc<CatalogEntry>(page, "agentSkills/setAccess", {
    skillId: created.id,
    bot: { botId: chiefId, enabled: true },
  });
  expect(included.availability).toBe("selected");
  expect(included.visibleBotIds).toContain(chiefId);
  expect(has(await listFor(chiefId))).toBe(true);

  await composer.fill("/");
  await expect(picker.getByRole("button", { name: "Skill Daily standup" })).toBeVisible();
});
