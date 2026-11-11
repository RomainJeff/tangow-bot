import type { Page } from "@playwright/test";
import { expect, test } from "./test";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

async function open(page: Page, viewport: typeof PHONE, name: string) {
  await page.setViewportSize(viewport);
  await page.goto(`/e2e/fixtures/touch-sizes.html?case=${name}`);
}

async function box(page: Page, selector: string) {
  const handle = page.locator(selector).first();
  await expect(handle).toBeVisible();
  await handle.evaluate((el) =>
    Promise.all(el.getAnimations().map((animation) => animation.finished)),
  );
  const rect = await handle.boundingBox();
  if (!rect) throw new Error(`${selector} has no box`);
  return rect;
}

async function hitTarget(page: Page, testId: string, dx: number, dy: number) {
  const rect = await box(page, `[data-testid="${testId}"]`);
  return page.evaluate(
    ({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return hit?.closest("button")?.dataset.testid ?? hit?.outerHTML.slice(0, 120) ?? null;
    },
    { x: rect.x + rect.width / 2 + dx, y: rect.y + rect.height / 2 + dy },
  );
}

const ICON_SIZES = {
  icon: 32,
  "icon-xs": 24,
  "icon-sm": 28,
  "icon-lg": 36,
  roundIcon: 34,
  roundIconSm: 28,
};

test("icon buttons keep their size and gain a 44px tap area on a phone only", async ({ page }) => {
  await open(page, PHONE, "buttons");
  for (const [size, visible] of Object.entries(ICON_SIZES)) {
    const rect = await box(page, `[data-testid="${size}"]`);
    expect([rect.width, rect.height]).toEqual([visible, visible]);
    expect(await hitTarget(page, size, 21, 21)).toBe(size);
    expect(await hitTarget(page, size, -21, -21)).toBe(size);
    expect(await hitTarget(page, size, 23, 0)).not.toBe(size);
  }

  const corner = await box(page, '[data-testid="corner"]');
  const host = await box(page, '[data-testid="absolute-host"]');
  expect(corner.x + corner.width).toBe(host.x + host.width - 8);
  expect(corner.y).toBe(host.y + 8);
  expect(await hitTarget(page, "corner", -21, 21)).toBe("corner");

  await open(page, DESKTOP, "buttons");
  for (const [size, visible] of Object.entries(ICON_SIZES)) {
    const rect = await box(page, `[data-testid="${size}"]`);
    expect([rect.width, rect.height]).toEqual([visible, visible]);
    expect(await hitTarget(page, size, visible / 2 + 2, 0)).not.toBe(size);
  }
});

test("an icon button's own box wins a tap over a touching neighbour's tap area", async ({
  page,
}) => {
  await open(page, PHONE, "adjacent");
  const hit = (x: number, y: number) =>
    page.evaluate(
      ({ x, y }) => document.elementFromPoint(x, y)?.closest("button")?.dataset.testid ?? null,
      { x, y },
    );
  for (const id of ["a", "b", "c"]) {
    const rect = await box(page, `[data-testid="${id}"]`);
    const centerX = rect.x + rect.width / 2;
    const centerY = rect.y + rect.height / 2;
    for (const inset of [1, 2, 8, 16]) {
      for (const [x, y] of [
        [rect.x + inset, centerY],
        [rect.x + rect.width - inset, centerY],
        [centerX, rect.y + inset],
        [centerX, rect.y + rect.height - inset],
      ]) {
        expect(await hit(x, y), `${id} inset ${inset} at ${x},${y}`).toBe(id);
      }
    }
    expect(await hit(centerX, rect.y - 5), `${id} above`).toBe(id);
    expect(await hit(centerX, rect.y + rect.height + 5), `${id} below`).toBe(id);
  }
  const first = await box(page, '[data-testid="a"]');
  const last = await box(page, '[data-testid="c"]');
  const middleY = first.y + first.height / 2;
  expect(await hit(first.x - 5, middleY)).toBe("a");
  expect(await hit(last.x + last.width + 5, middleY)).toBe("c");
});

test("text fields are 16px on a phone and keep 14px on desktop", async ({ page }) => {
  const fields = ["input", "textarea", "native-select", "select-trigger"];
  await open(page, PHONE, "fields");
  for (const id of fields) {
    await expect(page.getByTestId(id)).toHaveCSS("font-size", "16px");
  }
  await open(page, DESKTOP, "fields");
  for (const id of fields) {
    await expect(page.getByTestId(id)).toHaveCSS("font-size", "14px");
  }
});

test("menu and select items are at least 44px tall on a phone only", async ({ page }) => {
  for (const [name, item] of [
    ["menu", '[data-slot="dropdown-menu-item"]'],
    ["select", '[data-slot="select-item"]'],
  ]) {
    await open(page, PHONE, name);
    await expect(page.locator(item).first()).toBeVisible();
    expect(
      await page
        .locator(item)
        .first()
        .evaluate((el) => el.offsetHeight),
    ).toBeGreaterThanOrEqual(44);
    await open(page, DESKTOP, name);
    await expect(page.locator(item).first()).toBeVisible();
    expect(
      await page
        .locator(item)
        .first()
        .evaluate((el) => el.offsetHeight),
    ).toBeLessThan(32);
  }
});

test("segmented items are 36px tall on a phone and 28px on desktop", async ({ page }) => {
  await open(page, PHONE, "segmented");
  await expect(page.locator('[data-slot="segmented-control"] button').first()).toBeVisible();
  for (const selector of ['[data-slot="segmented-control"] button', '[data-slot="tabs-trigger"]']) {
    expect((await box(page, selector)).height).toBe(36);
  }
  await open(page, DESKTOP, "segmented");
  for (const selector of ['[data-slot="segmented-control"] button', '[data-slot="tabs-trigger"]']) {
    expect((await box(page, selector)).height).toBe(28);
  }
});

test("the window dialog fills the screen below 768px and floats from 768px", async ({ page }) => {
  for (const width of [390, 700, 767]) {
    await open(page, { width, height: 844 }, "window");
    expect(await box(page, '[data-slot="dialog-content"]')).toEqual({
      x: 0,
      y: 0,
      width,
      height: 844,
    });
  }
  await open(page, { width: 768, height: 844 }, "window");
  const floating = await box(page, '[data-slot="dialog-content"]');
  expect(floating.x).toBeGreaterThan(0);
  expect(floating.width).toBeLessThan(768);
});
