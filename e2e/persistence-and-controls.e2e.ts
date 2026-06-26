import { test, expect, type Page } from "@playwright/test";

/**
 * End-to-end coverage for the audit-log persistence + the ERP master-data
 * controls, driven through the REAL browser against the REAL backend (Mastra
 * agent on Claude + Supabase). Like the other e2e specs it needs ANTHROPIC_API_KEY
 * + DATABASE_URL and is NOT run in CI — run `pnpm e2e` locally before deploys.
 *
 * What the unit tests can't give, pinned here:
 *   1. A completed run is PERSISTED and shows in the Recent runs panel, and
 *      clicking it REPLAYS the stored trace with no new run (no model call).
 *   2. The two ERP controls that have no other e2e: an invoice already posted in
 *      the ERP is blocked (`duplicate_in_erp`), and a bill from an ERP-inactive
 *      vendor is flagged (`vendor_inactive`).
 *
 * Seeded rows used (ids = the queue's stable keys):
 *   INV-2042  — price mismatch (exception → pauses for approval)
 *   INV-1990  — already posted as a bill in the ERP (duplicate_in_erp → blocked)
 *   INV-2050  — billing vendor is inactive in the ERP (vendor_inactive)
 */

const RUN_TIMEOUT = 30_000;

const selectAndRun = async (page: Page, rowId: string) => {
  await page.getByTestId(`queue-row-${rowId}`).click();
  await page.getByTestId("run-btn").click();
};

/** A trace step node for a stage, with its status exposed via data-status. */
const step = (page: Page, stage: string) =>
  page.locator(`[data-testid="trace-step-${stage}"]`);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // The app opens on the "Build the workflow" tab; the pipeline lives behind the
  // "Run it on invoices" tab. Switch to it, then the seeded queue must be visible.
  await page.getByRole("button", { name: /Run it on invoices/ }).click();
  await expect(page.getByText("Invoice queue")).toBeVisible();
});

test("a completed run is logged in Recent runs and replays without re-running", async ({
  page,
}) => {
  // Run a price-mismatch invoice to a terminal-for-this-phase state (it pauses for
  // approval). The run is persisted as an audit row the moment the stream ends.
  await selectAndRun(page, "INV-2042");
  await expect(page.getByTestId("approval-gate")).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  // Approve so the run reaches a final outcome (posted) — that's when the dashboard
  // refreshes the Recent runs list.
  await page.getByTestId("approve-btn").click();
  await expect(step(page, "reconciliation")).toHaveAttribute(
    "data-status",
    "ok",
    { timeout: RUN_TIMEOUT },
  );

  // 1. The run now appears in the Recent runs panel (id is invoiceNumber + a UUID,
  //    so match by prefix). Poll: the list refetches on completion.
  const historyRow = page
    .locator('[data-testid^="run-history-INV-2042"]')
    .first();
  await expect(historyRow).toBeVisible({ timeout: RUN_TIMEOUT });

  // 2. Clicking it REPLAYS the stored trace: the stages re-render, but no new run
  //    is kicked off — the Run button never shows "Running…", and the approval
  //    gate does not reappear (a replay is a finished, read-only render).
  await historyRow.click();
  await expect(step(page, "matching")).toBeVisible();
  await expect(step(page, "reconciliation")).toBeVisible();
  await expect(page.getByText("Running…")).toHaveCount(0);
  // Exactly one node per stage — a replay sets the trace, it doesn't stack a run.
  await expect(step(page, "matching")).toHaveCount(1);
});

test("an invoice already posted in the ERP is blocked as a duplicate", async ({
  page,
}) => {
  await selectAndRun(page, "INV-1990");

  // Matching blocks it as a duplicate (red), driven by the pulled posted-bill list.
  await expect(step(page, "matching")).toHaveAttribute("data-status", "error", {
    timeout: RUN_TIMEOUT,
  });
  // The ERP-duplicate control surfaces its badge + message; nothing posts.
  await expect(
    page.getByText(/already posted as a bill in the ERP/i),
  ).toBeVisible();
  await expect(page.getByText(/NETSUITE-BILL-/)).toHaveCount(0);
  // It's a control failure, not an approval question — no human gate.
  await expect(page.getByTestId("approval-gate")).toHaveCount(0);
});

test("a bill from an ERP-inactive vendor is flagged for review", async ({
  page,
}) => {
  await selectAndRun(page, "INV-2050");

  // Matching flags an exception (amber), including the inactive-vendor control.
  await expect(step(page, "matching")).toHaveAttribute("data-status", "warn", {
    timeout: RUN_TIMEOUT,
  });
  await expect(page.getByText(/marked inactive in the ERP/i)).toBeVisible();
});

test("a cleared invoice shows the dry-run bill it would post to the ERP", async ({
  page,
}) => {
  // INV-2040 is a clean match → posts straight through (no human gate). The
  // reconciliation detail then shows the DRY-RUN vendor bill: the exact payload a
  // real write-back would POST, labelled so it can't be mistaken for a real post.
  await selectAndRun(page, "INV-2040");
  await expect(step(page, "reconciliation")).toHaveAttribute(
    "data-status",
    "ok",
    { timeout: RUN_TIMEOUT },
  );

  const bill = page.getByTestId("vendor-bill-dryrun");
  await expect(bill).toBeVisible();
  await expect(bill).toContainText("dry-run");
  await expect(bill).toContainText("INV-2040"); // the doc number
  await expect(bill).toContainText("Atlas Fasteners"); // the vendor
});
