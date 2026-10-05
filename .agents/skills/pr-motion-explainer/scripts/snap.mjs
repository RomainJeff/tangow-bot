// Screenshot every step of every mode + a 375px mobile check. Usage:
//   node snap.mjs <explainer.html> <out-dir>
// Resolves playwright from the global install when it is not a local dependency.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [file, out = "snaps"] = process.argv.slice(2);
if (!file) { console.error("usage: node snap.mjs <explainer.html> <out-dir>"); process.exit(2); }
const req = createRequire(import.meta.url);
let pw;
try { pw = req("playwright"); } catch { pw = req(path.join(execSync("npm root -g").toString().trim(), "playwright")); }
// CHROMIUM_PATH points at a system Chromium when Playwright's own browsers are not installed.
const browser = await pw.chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
mkdirSync(out, { recursive: true });
const url = pathToFileURL(path.resolve(file)).href;
const errors = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: process.env.SCHEME || "dark" });
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(url);
await page.waitForTimeout(400);
const modes = await page.evaluate(() => Object.fromEntries(Object.entries(MODES).map(([m, s]) => [m, s.length])));
const shots = [];
for (const [m, n] of Object.entries(modes)) for (let k = 0; k < n; k++) {
  await page.evaluate(([m, k]) => __J(m, k), [m, k]);
  await page.waitForTimeout(650);
  const f = path.join(out, `${m}-${String(k + 1).padStart(2, "0")}.png`);
  await page.locator(".app").screenshot({ path: f });
  shots.push(f);
}
// Overlap check: node boxes and tags must not intersect each other.
const overlaps = await page.evaluate(() => {
  const items = [...document.querySelectorAll("#nodes > g, #tags > g:not(.hidden) rect")].map((e) => [e, e.getBoundingClientRect()]);
  const hit = [];
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const [a, A] = items[i], [b, B] = items[j];
    if (!A.width || !B.width) continue;
    if (A.left < B.right && B.left < A.right && A.top < B.bottom && B.top < A.bottom) hit.push(`${a.textContent.slice(0, 30)} ↔ ${b.textContent.slice(0, 30)}`);
  }
  return hit;
});
const mob = await browser.newPage({ viewport: { width: 375, height: 800 } });
await mob.goto(url); await mob.waitForTimeout(400);
const hscroll = await mob.evaluate(() => document.documentElement.scrollWidth > innerWidth);
await mob.screenshot({ path: path.join(out, "mobile.png") });
await browser.close();
console.log(JSON.stringify({ shots: shots.length, errors, overlaps_last_step: overlaps, mobile_horizontal_scroll: hscroll }, null, 1));
