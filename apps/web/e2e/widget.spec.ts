// Needs the Vite dev server: the fixture is served from source and is not a build entry.
import { captureScreenshot } from "./helpers";
import { expect, test } from "./test";

const html = `
<div class="stack">
  <h1>Launch overview</h1>
  <div class="grid"><div class="card stat"><div class="value">3</div><div class="label">Ready to launch</div></div><div class="card"><span class="badge">On track</span><p>Research, writing and support.</p></div></div>
  <figure class="media"><img src="https://media.example.test/view.svg" alt="Mountain landscape"><figcaption>A view from the trail</figcaption></figure>
  <div class="row"><button class="button" onclick="this.textContent='Reviewed'">Review checklist</button><a href="https://destination.example.test/view">Read the guide</a></div>
  <small id="parent"></small><small id="network"></small>
</div>
<script>
try { window.parent.document.body; document.getElementById('parent').textContent = 'Parent accessible'; }
catch { document.getElementById('parent').textContent = 'Parent blocked'; }
fetch('https://network.example.test/data').then(() => document.getElementById('network').textContent = 'Fetch allowed', () => document.getElementById('network').textContent = 'Fetch blocked');
</script>`;

test("artifact widgets isolate scripts and network, retain links, and open in full screen", async ({
  page,
  context,
}, testInfo) => {
  let reads = 0;
  const networkRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("network.example.test")) networkRequests.push(request.url());
  });
  // Interception supplies immutable artifact bytes and HTTPS media without external services.
  // HTTP caching is irrelevant here: this spec checks sandbox and frame lifecycle, not caching.
  await page.route("**/rpc/artifacts/get", async (route) => {
    reads += 1;
    await route.fulfill({
      json: {
        json: {
          id: "widget-1",
          name: "view.html",
          mimeType: "text/html",
          contentBase64: Buffer.from(html).toString("base64"),
        },
      },
    });
  });
  await context.route("https://media.example.test/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450"><path fill="#ddd" d="M0 0h800v450H0z"/><path fill="#777" d="m0 450 300-350 200 200 120-130 180 280"/></svg>',
    }),
  );
  await context.route("https://destination.example.test/**", (route) =>
    route.fulfill({ body: "Guide destination" }),
  );
  await page.goto("/e2e/fixtures/widget.html");
  const inline = page.frameLocator("iframe").first();
  await expect(inline.getByText("Parent blocked", { exact: true })).toBeVisible();
  await expect(inline.getByText("Fetch blocked", { exact: true })).toBeVisible();
  await expect(inline.getByAltText("Mountain landscape")).toBeVisible();
  expect(
    await inline
      .getByAltText("Mountain landscape")
      .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
  ).toBe(true);
  await expect(page.locator("iframe")).toHaveAttribute("srcdoc", /Content-Security-Policy/);
  expect(networkRequests).toEqual([]);
  const contentHeight = await inline
    .locator("body")
    .evaluate((body) => Math.ceil(body.getBoundingClientRect().height));
  expect(contentHeight).toBeGreaterThan(640);
  await expect(page.locator("iframe")).toHaveCSS("height", `${contentHeight}px`);
  const popupPromise = context.waitForEvent("page");
  await inline.getByRole("link", { name: "Read the guide" }).click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL("https://destination.example.test/view");
  await popup.close();
  await expect(inline.getByRole("button", { name: "Review checklist" })).toBeVisible();
  await inline.getByRole("button", { name: "Review checklist" }).click();
  await expect(inline.getByRole("button", { name: "Reviewed", exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.postMessage(JSON.stringify({ rakazoWidgetHeight: 1 }), "*");
    document.documentElement.dataset.theme = "dark";
  });
  await expect(inline.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(inline.getByRole("button", { name: "Reviewed", exact: true })).toBeVisible();
  await expect(page.locator("iframe")).toHaveCSS("height", `${contentHeight}px`);
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  await expect(inline.locator("html")).toHaveAttribute("data-theme", "light");
  await captureScreenshot(page, testInfo, "widget-desktop");
  await page.getByRole("button", { name: "Open in full screen" }).focus();
  await page.getByRole("button", { name: "Open in full screen" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.frameLocator("iframe").getByRole("button", { name: "Review checklist" }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "widget-full-screen");
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(inline.getByRole("button", { name: "Reviewed", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await captureScreenshot(page, testInfo, "widget-phone");
  expect(reads).toBe(1);
});

test("caps and shrinks content height, then hides a widget that navigates its own frame", async ({
  page,
}) => {
  // Interception supplies an artifact that navigates itself; caching does not affect this lifecycle proof.
  await page.route("**/rpc/artifacts/get", (route) =>
    route.fulfill({
      json: {
        json: {
          contentBase64: Buffer.from(
            `<button onclick="document.getElementById('panel').hidden=true">Collapse</button><button onclick="location.href='about:blank'">Leave</button><div id="panel" style="height:25000px"></div>`,
          ).toString("base64"),
        },
      },
    }),
  );
  await page.goto("/e2e/fixtures/widget.html");
  await expect(page.locator("iframe")).toHaveCSS("height", "20000px");
  const frame = page.frameLocator("iframe");
  await frame.getByRole("button", { name: "Collapse" }).click();
  const collapsed = await frame
    .locator("body")
    .evaluate((body) => Math.ceil(body.getBoundingClientRect().height));
  expect(collapsed).toBeLessThan(200);
  await expect(page.locator("iframe")).toHaveCSS("height", `${collapsed}px`);
  await frame.getByRole("button", { name: "Leave" }).click();
  await expect(page.locator("iframe")).toBeHidden();
});
