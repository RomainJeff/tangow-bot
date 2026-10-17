import { writeFileSync } from "node:fs";
import { activeBotId, completeOnboarding, rpc, signup } from "./helpers";
import type { Page } from "./test";
import { expect, test } from "./test";
import { threadEntries } from "./thread-log";

type Rect = { x: number; y: number; width: number; height: number };
type Frame = {
  t: number;
  busy: boolean;
  clone: Rect | null;
  card: Rect;
  above: Rect;
  bubble: Rect | null;
  bubbleVisible: boolean;
  scrollTop: number;
  scrollMax: number;
  fold: number;
  rows: number;
};

/** Opens the city question after `history` earlier exchanges, scrolled to the end of the thread. */
async function openCityCard(page: Page, name: string, history = 0) {
  await signup(page, `${name}-${Date.now()}@rakazo.test`, "password12", "Ask Motion");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  for (let turn = 1; turn <= history; turn++) {
    await page.getByPlaceholder(/Message/).fill(`note ${turn} for the motion check`);
    await page.keyboard.press("Enter");
    await expect
      .poll(
        async () =>
          (await threadEntries(page, { botId })).filter((entry) => entry.type === "run.finished")
            .length,
        { timeout: 60_000 },
      )
      .toBe(turn);
  }
  await page.getByPlaceholder(/Message/).fill("pick from these cities with tappable choices");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () =>
        (await rpc<{ run?: { status: string } | null }>(page, "threads/get", { botId })).run
          ?.status,
      { timeout: 60_000 },
    )
    .toBe("waiting_input");
  const seoul = page.getByRole("button", { name: "Seoul", exact: true });
  if ((await seoul.count()) === 0) await page.reload({ waitUntil: "domcontentloaded" });
  await expect(seoul).toBeVisible({ timeout: 15_000 });
  return seoul;
}

/** Taps the tile and records every frame until `ms` after the hold has ended. */
async function sampleCommit(page: Page, tile: ReturnType<Page["getByRole"]>, ms: number) {
  await page.evaluate((window_) => {
    const transcript = document.querySelector('[data-testid="transcript"]') as HTMLElement;
    const card = document.querySelector('[data-slot="question-card"]') as HTMLElement;
    const rows = [...transcript.querySelectorAll("[data-message-id]")];
    const above = rows[rows.indexOf(card.closest("[data-message-id]") as Element) - 1] as Element;
    const rect = (element: Element | null) => {
      if (!element) return null;
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    const flights: number[] = [];
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLElement && node.matches("[data-ask-flight]")) flights.push(1);
        }
      }
    }).observe(card, { childList: true, subtree: true });
    const frames: Frame[] = [];
    let heldAt: number | null = null;
    const probe = window as unknown as { commit: Promise<{ frames: Frame[]; flights: number[] }> };
    probe.commit = new Promise((resolve) => {
      const step = (now: number) => {
        const bubble = card.querySelector('[data-slot="user-bubble"]');
        const frame = {
          t: now,
          busy: Boolean(card.querySelector("fieldset:disabled")),
          clone: rect(card.querySelector("[data-ask-flight]")),
          card: rect(card) as Rect,
          above: rect(above) as Rect,
          bubble: rect(bubble),
          bubbleVisible: Boolean(bubble && getComputedStyle(bubble).visibility === "visible"),
          scrollTop: transcript.scrollTop,
          scrollMax: transcript.scrollHeight - transcript.clientHeight,
          fold: (card.firstElementChild as Element).getBoundingClientRect().height,
          rows: transcript.querySelectorAll("[data-message-id]").length,
        };
        frames.push(frame);
        if (frame.busy && heldAt === null) heldAt = frame.t;
        if (heldAt !== null && frame.t - heldAt > window_) resolve({ frames, flights });
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }, ms);
  const clicked = await page.evaluate(() => performance.now());
  await tile.click();
  const { frames, flights } = await page.evaluate(
    () => (window as unknown as { commit: Promise<{ frames: Frame[]; flights: number[] }> }).commit,
  );
  return { frames, flights, clicked };
}

/** How far each frame has gone from `from` to `to`, as a fraction of the way. */
const progress = (values: number[], from: number, to: number) =>
  values.map((value) => (value - from) / (to - from));

/** The largest step back against the direction of travel, and the largest overshoot past `to`. */
function wobble(values: number[], from: number, to: number) {
  const sign = Math.sign(to - from);
  let best = from;
  let back = 0;
  let over = 0;
  for (const value of values) {
    if ((value - best) * sign > 0) best = value;
    back = Math.max(back, (best - value) * sign);
    over = Math.max(over, (value - to) * sign);
  }
  return { back, over };
}

/** The spring's steepest stretch moves 0.78% of the way per ms; no frame may outrun it. */
const STEEPEST_PER_MS = 0.0078;

for (const { viewport, history, band } of [
  { viewport: { width: 1440, height: 640 }, history: 2, band: "long thread" },
  { viewport: { width: 390, height: 700 }, history: 0, band: "short thread" },
]) {
  test(`the answer flies to its bubble while the card folds, in one movement (CA5, ${viewport.width}, ${band})`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    const seoul = await openCityCard(page, `ask-motion-${viewport.width}`, history);
    await expect(seoul).toBeInViewport();
    const { frames, flights } = await sampleCommit(page, seoul, 1000);

    const held = frames.findIndex((frame) => frame.busy);
    const first = frames.findIndex((frame) => frame.clone);
    const last = frames.findLastIndex((frame) => frame.clone);
    const before = frames[first - 1]!;
    const final = frames.at(-1)!;
    const flying = frames.slice(first, last + 1);
    const after = frames.slice(last + 1);
    const bubble = final.bubble!;
    const track = (pick: (frame: Frame) => number, from: number, to: number) => ({
      values: flying.map(pick),
      from,
      to,
    });
    const series = {
      cloneX: track((f) => f.clone!.x, flying[0]!.clone!.x, bubble.x),
      cloneY: track((f) => f.clone!.y, flying[0]!.clone!.y, bubble.y),
      cloneWidth: track((f) => f.clone!.width, flying[0]!.clone!.width, bubble.width),
      cardTop: track((f) => f.card.y, before.card.y, final.card.y),
      cardHeight: track((f) => f.fold, before.card.height, final.card.height),
      rowAbove: track((f) => f.above.y, before.above.y, final.above.y),
    };
    const moving = Object.entries(series).filter(([, s]) => Math.abs(s.to - s.from) >= 8);
    const curves = moving.map(([name, s]) => [name, progress(s.values, s.from, s.to)] as const);
    const spread = flying.map(
      (_, index) =>
        Math.max(...curves.map(([, p]) => p[index]!)) -
        Math.min(...curves.map(([, p]) => p[index]!)),
    );
    const ends = curves.map(([name, p]) => [name, p.findIndex((value) => value >= 0.995)] as const);
    const outrun = moving.map(([name, s]) => {
      const steps = s.values.map((value, index) => {
        const previous = index ? s.values[index - 1]! : s.from;
        const ms = flying[index]!.t - frames[first + index - 1]!.t;
        return Math.abs(value - previous) - Math.abs(s.to - s.from) * STEEPEST_PER_MS * ms;
      });
      return [name, Math.max(...steps)] as const;
    });
    const scrolled = before.scrollTop - final.scrollTop;
    const report = {
      viewport,
      band,
      frames: frames.length,
      longestFrameMs: Math.max(...frames.slice(1).map((f, i) => f.t - frames[i]!.t)),
      fillMs: Math.round(frames[first]!.t - frames[held]!.t),
      flightMs: Math.round(frames[last + 1]!.t - frames[first]!.t),
      fold: before.card.height - final.card.height,
      scrollRoom: before.scrollTop,
      scrolled,
      wobble: Object.fromEntries(
        Object.entries(series).map(([name, s]) => [name, wobble(s.values, s.from, s.to)]),
      ),
      maxCurveSpread: Math.max(...spread),
      endFrames: Object.fromEntries(ends),
      outrunPx: Object.fromEntries(outrun),
      finalDelta: {
        x: Math.abs(flying.at(-1)!.clone!.x - bubble.x),
        y: Math.abs(flying.at(-1)!.clone!.y - bubble.y),
        width: Math.abs(flying.at(-1)!.clone!.width - bubble.width),
        height: Math.abs(flying.at(-1)!.clone!.height - bubble.height),
      },
      rowAboveMoved: final.above.y - before.above.y,
    };
    writeFileSync(testInfo.outputPath("ca5-frames.json"), JSON.stringify(frames));
    writeFileSync(testInfo.outputPath("ca5-report.json"), JSON.stringify(report, null, 2));
    await testInfo.attach("ca5-report", { path: testInfo.outputPath("ca5-report.json") });

    expect(report.fold).toBeGreaterThan(200);
    // The long thread can give up the whole fold in scroll; the short one only part of it.
    if (history) expect(report.scrollRoom).toBeGreaterThanOrEqual(report.fold);
    else expect(report.scrollRoom).toBeLessThan(report.fold);
    expect(flights).toHaveLength(1);
    expect(report.fillMs).toBeGreaterThanOrEqual(64);
    expect(report.fillMs).toBeLessThanOrEqual(130);
    for (const { back, over } of Object.values(report.wobble)) {
      expect(back).toBeLessThanOrEqual(3);
      expect(over).toBeLessThanOrEqual(3);
    }
    for (const delta of Object.values(report.finalDelta)) expect(delta).toBeLessThanOrEqual(1);
    expect(report.maxCurveSpread).toBeLessThanOrEqual(0.05);
    const endFrames = ends.map(([, index]) => index);
    expect(Math.max(...endFrames) - Math.min(...endFrames)).toBeLessThanOrEqual(1);
    for (const [, px] of outrun) expect(px).toBeLessThanOrEqual(1);
    // The rows above come down by what the scroll gave up, then stay.
    expect(Math.abs(report.rowAboveMoved - scrolled)).toBeLessThanOrEqual(1);
    expect(new Set(after.map((f) => Math.round(f.above.y)))).toEqual(
      new Set([Math.round(final.above.y)]),
    );
    // Never the clone and the bubble at once, never neither.
    expect(flying.every((f) => !f.bubbleVisible)).toBe(true);
    expect(after.every((f) => f.bubbleVisible)).toBe(true);
    // The bot's reply lands after the window, so nothing else moved the thread.
    expect(new Set(frames.map((f) => f.rows)).size).toBe(1);
  });
}

test("with reduced motion the answer fades in after the same hold, with no flight (CA13)", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const seoul = await openCityCard(page, "ask-motion-reduced");
  const answered = page.waitForRequest((request) => request.url().includes("/rpc/threads/answer"));
  const { frames, flights, clicked } = await sampleCommit(page, seoul, 700);
  await answered;
  const held = frames.find((frame) => frame.busy)!;

  expect(flights).toEqual([]);
  expect(held.t - clicked).toBeGreaterThanOrEqual(640);
  // The card goes from its open height to its settled height in one step.
  expect(new Set(frames.map((frame) => Math.round(frame.card.height))).size).toBe(2);
  await expect(page.getByRole("group", { name: "Your answer: Seoul" })).toBeVisible();
});

test("an answer that fails mid-flight reopens the card on the choice, with no bubble left (CA4)", async ({
  page,
}) => {
  const seoul = await openCityCard(page, "ask-motion-failed");
  await page.route("**/rpc/threads/answer", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.abort();
  });
  const { frames } = await sampleCommit(page, seoul, 900);

  expect(frames.some((frame) => frame.clone)).toBe(true);
  expect(frames.at(-1)!.clone).toBeNull();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(seoul).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-slot="question-card"] [data-slot="user-bubble"]')).toHaveCount(
    0,
  );
  expect(
    await page.getByTestId("transcript").evaluate((element) => element.style.overflowAnchor),
  ).toBe("");
});
