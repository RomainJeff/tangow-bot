import { writeFileSync } from "node:fs";
import path from "node:path";
import { type BrowserContext, test as base, type Page } from "@playwright/test";
import {
  type ScriptCoverage,
  touchedFiles,
  viteDocumentToRepoFile,
  viteUrlToRepoFile,
} from "../../../packages/testkit/src/e2e-impact";

export * from "@playwright/test";

const impactDir = process.env.E2E_IMPACT_DIR;

/**
 * Specs import `test` from here. Under `pnpm test:e2e:impact-map` it records the
 * repo files each test ran, in the browser and in the API, for the impact map.
 */
export const test = base.extend<{ impact: undefined }>({
  impact: [
    async ({ page, browser, baseURL }, use, testInfo) => {
      const testDir = testInfo.project.testDir;
      const webRoot = path.dirname(testDir);
      const repoRoot = path.resolve(webRoot, "../..");
      const origin = new URL(baseURL!).origin;
      const toRepoFile = (url: string) => viteUrlToRepoFile(url, origin, webRoot, repoRoot);
      const apiImpact = () =>
        fetch(`${process.env.API_URL}/__e2e/impact`).then((response) => response.json());

      const scripts: ScriptCoverage[] = [];
      const documents = new Set<string>();
      const recording = new Set<Page>();
      const stop = async (tracked: Page) => {
        if (!recording.delete(tracked)) return;
        scripts.push(...(await tracked.coverage.stopJSCoverage().catch(() => [])));
      };
      // Coverage dies with its page, so collect it before a test closes one.
      const track = async (tracked: Page) => {
        recording.add(tracked);
        tracked.on("framenavigated", (frame) => documents.add(frame.url()));
        const close = tracked.close.bind(tracked);
        tracked.close = async (options) => {
          await stop(tracked);
          return close(options);
        };
        await tracked.coverage.startJSCoverage({ resetOnNavigation: false });
      };
      const watch = (context: BrowserContext) => {
        context.on("page", (opened) => void track(opened).catch(() => undefined));
        const close = context.close.bind(context);
        context.close = async (options) => {
          await Promise.all(context.pages().map(stop));
          return close(options);
        };
      };
      await track(page);
      watch(page.context());
      const newContext = browser.newContext;
      browser.newContext = async (options) => {
        const context = await newContext.call(browser, options);
        watch(context);
        return context;
      };
      await apiImpact();

      await use(undefined);

      browser.newContext = newContext;
      const apiFiles = (await apiImpact()) as string[];
      await Promise.all([...recording].map(stop));
      const pageFiles = [...documents]
        .map((url) => viteDocumentToRepoFile(url, origin, webRoot, repoRoot))
        .filter((file) => file !== undefined);
      const files = new Set([...apiFiles, ...touchedFiles(scripts, toRepoFile), ...pageFiles]);
      writeFileSync(
        path.join(impactDir!, `${testInfo.testId}.json`),
        JSON.stringify({ spec: path.relative(testDir, testInfo.file), files: [...files].sort() }),
      );
    },
    { auto: impactDir !== undefined },
  ],
});
