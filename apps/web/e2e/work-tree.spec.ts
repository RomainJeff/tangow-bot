import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("a coordinator's tasks unfold under its cards and show an approval its card allows", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `work-tree-${stamp}@rakazo.test`, "password12", "Ada Lovelace");
  await completeOnboarding(page);
  // A thread without delegated work offers no tasks to unfold.
  await expect(page.getByTestId("task-tree-disclosure")).toHaveCount(0);

  // The specialist's destination write waits for the owner, then runs on the scripted runtime.
  await page.request.post("/rpc/approvalRules/set", {
    data: {
      json: { effect: "require_approval", matchKind: "connector", matchValue: "destination.write" },
    },
  });
  await page
    .getByPlaceholder(/Message/)
    .fill("delegate to a researcher: write this to the destination crm as a note");
  await page.keyboard.press("Enter");

  // The approval reaches the coordinator's thread, and with it the link to the tasks.
  const askCard = page.getByTestId("work-ask-card");
  await expect(askCard).toBeVisible({ timeout: 30_000 });
  await expect(askCard.getByText("Needs your call")).toBeVisible();

  const link = askCard.getByRole("button", { name: "1 task", exact: true });
  await expect(link).toHaveAttribute("aria-expanded", "false");
  await link.click();
  await expect(link).toHaveAttribute("aria-expanded", "true");

  const line = askCard.getByTestId("task-tree-line");
  await expect(line.getByText("Researcher", { exact: true })).toBeVisible();
  await expect(line.getByText("Needs your call")).toBeVisible();
  await expect(line.getByText("Rakazo · default")).toBeVisible();
  await expect(line.getByText("Review before writing", { exact: false })).toBeVisible();
  await captureScreenshot(page, testInfo, "work-tree-pending-approval");

  // Only the actions that apply to a task still working are offered.
  await line.getByRole("button", { name: "Actions for Researcher" }).click();
  await expect(page.getByRole("menuitem", { name: "Cancel" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "View thread" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Close", exact: true })).toHaveCount(0);
  // Cancelling asks first; keeping the task leaves it untouched.
  await page.getByRole("menuitem", { name: "Cancel" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm.getByText("Cancel Researcher?")).toBeVisible();
  await confirm.getByRole("button", { name: "Keep" }).click();
  await expect(confirm).toHaveCount(0);
  await expect(line.getByText("Needs your call")).toBeVisible();

  // The tree shows the approval but settles nothing: that is the card's job.
  await expect(line.getByRole("button", { name: "Allow once", exact: true })).toHaveCount(0);
  await askCard.getByRole("button", { name: "Allow once", exact: true }).click();

  // The settled approval says who allowed it, and the task ends without a reload.
  await expect(askCard).toHaveCount(0, { timeout: 30_000 });
  const returnCard = page.getByTestId("work-return-card");
  await expect(returnCard).toBeVisible({ timeout: 30_000 });
  await page.getByTestId("task-tree-disclosure").getByRole("button", { name: "1 task" }).click();
  const settled = page.getByTestId("task-tree-line");
  await expect(settled.getByText(/· allowed by Ada Lovelace$/)).toBeVisible();
  await expect(settled.getByText("No result", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "work-tree-approval-allowed");

  // A returned task can be closed, and its specialist's thread read without writing to it.
  await settled.getByRole("button", { name: "Actions for Researcher" }).click();
  await expect(page.getByRole("menuitem", { name: "Close", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "View thread" }).click();
  const thread = page.getByTestId("work-thread-dialog");
  await expect(thread).toBeVisible();
  await expect(thread.getByRole("textbox")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "work-tree-specialist-thread");
  await page.keyboard.press("Escape");
  await expect(thread).toHaveCount(0);

  await settled.getByRole("button", { name: "Actions for Researcher" }).click();
  await page.getByRole("menuitem", { name: "Close", exact: true }).click();
  await expect(settled.getByText("Closed", { exact: true })).toBeVisible();
});
