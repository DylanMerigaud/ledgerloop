import { test, expect, type Page } from "@playwright/test";

/**
 * End-to-end test of the human-in-the-loop approval flow, driven through the REAL
 * browser against the REAL backend (Mastra agent on Claude Haiku + Supabase).
 *
 * This is the check the unit/integration tests can't give: it exercises the
 * actual React hook's cross-phase trace accumulation, the Approve/Reject
 * rendering, and the pause → resume UX as a user experiences it. It needs
 * ANTHROPIC_API_KEY + DATABASE_URL in the environment, so it is NOT run in CI —
 * run `pnpm e2e` locally (with .env loaded) before deploys.
 *
 * Seeded rows used (ids are the queue's stable keys):
 *   INV-2040          — clean 3-way match (straight-through, no human)
 *   INV-2042          — price mismatch (exception → pauses for approval)
 */

const RUN_TIMEOUT = 30_000; // a 4-agent Haiku run is a few seconds; allow margin

async function selectAndRun(page: Page, rowId: string) {
  await page.getByTestId(`queue-row-${rowId}`).click();
  await page.getByTestId("run-btn").click();
}

/** A trace step node for a stage, with its status exposed via data-status. */
function step(page: Page, stage: string) {
  return page.locator(`[data-testid="trace-step-${stage}"]`);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // The dashboard must have loaded with seeded data (not the "needs its database"
  // notice). If this fails, the backend env isn't configured.
  await expect(page.getByText("Invoice queue")).toBeVisible();
});

test("clean invoice runs straight through — no approval gate", async ({
  page,
}) => {
  await selectAndRun(page, "INV-2040");

  // Reconciliation resolves to ok (posted), and the approval gate never appears.
  await expect(step(page, "reconciliation")).toHaveAttribute(
    "data-status",
    "ok",
    {
      timeout: RUN_TIMEOUT,
    },
  );
  await expect(page.getByTestId("approval-gate")).toHaveCount(0);
  await expect(page.getByText("Pipeline complete")).toBeVisible();
});

test("price-mismatch pauses for approval, then APPROVE posts it", async ({
  page,
}) => {
  await selectAndRun(page, "INV-2042");

  // 1. Matching catches the variance (amber).
  await expect(step(page, "matching")).toHaveAttribute("data-status", "warn", {
    timeout: RUN_TIMEOUT,
  });

  // 2. The run PAUSES: reconciliation is "waiting", the gate + banner appear.
  await expect(step(page, "reconciliation")).toHaveAttribute(
    "data-status",
    "waiting",
    {
      timeout: RUN_TIMEOUT,
    },
  );
  await expect(page.getByTestId("approval-gate")).toBeVisible();
  await expect(page.getByText(/Paused/)).toBeVisible();
  // It has NOT posted yet — no ERP reference on the trace.
  await expect(page.getByText(/NETSUITE-BILL-/)).toHaveCount(0);

  // 3. Approve → reconciliation transitions to posted, gate disappears.
  await page.getByTestId("approve-btn").click();
  await expect(step(page, "reconciliation")).toHaveAttribute(
    "data-status",
    "ok",
    {
      timeout: RUN_TIMEOUT,
    },
  );
  // The ERP ref shows up (both in the narration and the detail row) — assert at
  // least one match rather than a single visible node.
  await expect(page.getByText(/NETSUITE-BILL-/).first()).toBeVisible();
  await expect(page.getByTestId("approval-gate")).toHaveCount(0);

  // 4. No duplicated stage nodes after the resume (this is the audit-bug guard —
  //    a phase-2 resume must upsert the stages in place, not stack a second set).
  //    Exactly one node per stage. (Intake is shown by the extraction reveal, not
  //    a timeline node — assert the reveal is present exactly once instead.)
  await expect(page.getByTestId("extraction-reveal")).toHaveCount(1);
  await expect(step(page, "matching")).toHaveCount(1);
  await expect(step(page, "approval")).toHaveCount(1);
  await expect(step(page, "reconciliation")).toHaveCount(1);
  // No stray "Pipeline started" duplicated by the resume. (Run markers are pruned
  // at the pause and the resume adds none, so the count is 0 here — the bug we're
  // guarding against would make it ≥ 1 from a re-emitted phase-2 marker.)
  await expect(page.getByText("Pipeline started")).toHaveCount(0);
});

test("price-mismatch REJECT leaves it un-posted", async ({ page }) => {
  await selectAndRun(page, "INV-2042");

  await expect(page.getByTestId("approval-gate")).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  await page.getByTestId("reject-btn").click();

  // Reconciliation ends in error (rejected), and nothing was posted.
  await expect(step(page, "reconciliation")).toHaveAttribute(
    "data-status",
    "error",
    {
      timeout: RUN_TIMEOUT,
    },
  );
  await expect(page.getByText(/NETSUITE-BILL-/)).toHaveCount(0);
  await expect(page.getByText(/[Rr]eject/).first()).toBeVisible();
});
