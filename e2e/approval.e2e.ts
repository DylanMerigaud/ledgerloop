import { expect, type Page, test } from "@playwright/test";

/**
 * End-to-end test of the human-in-the-loop approval flow, driven through the REAL
 * browser against the REAL backend (Mastra agent on Claude Haiku + Supabase).
 *
 * This is the check the unit/integration tests can't give: it exercises the
 * actual React hook's cross-phase trace accumulation, the Approve/Reject
 * rendering, and the pause → resume UX as a user experiences it. It needs
 * ANTHROPIC_API_KEY + DATABASE_URL in the environment, so it is NOT run in CI,
 * run `pnpm e2e` locally (with .env loaded) before deploys.
 *
 * Seeded rows used (ids are the queue's stable keys):
 *   INV-2040         , clean 3-way match (straight-through, no human)
 *   INV-2042         , price mismatch (exception → pauses for approval)
 */

const RUN_TIMEOUT = 45_000; // a Haiku run is usually a few seconds, but the model can
// occasionally take 30s+; give the pause/resume asserts headroom so latency isn't a flake

const selectAndRun = async (page: Page, rowId: string) => {
  await page.getByTestId(`queue-row-${rowId}`).click();
  await page.getByTestId("run-btn").click();
};

/** The graph is the hero; the step-by-step trace lives in a drawer over it. Open it
    so the trace-step assertions can see the nodes. */
const openTrace = async (page: Page) => {
  await page.getByTestId("view-trace").click({ timeout: RUN_TIMEOUT });
};

/** A trace step node for a stage (inside the drawer), status via data-status. */
const step = (page: Page, stage: string) => {
  return page.locator(`[data-testid="trace-step-${stage}"]`);
};

/** Decide a paused gate on its node, then submit. The decision is ON the canvas, so
    close the trace drawer first if it's open (the gate is behind it). */
const decideGate = async (
  page: Page,
  stepId: string,
  choice: "approve" | "reject",
  reason?: string
) => {
  const close = page.getByTestId("trace-close");
  let isCloseVisible: boolean;
  try {
    isCloseVisible = await close.isVisible();
  } catch {
    isCloseVisible = false; // locator resolution can race a teardown, treat as not shown
  }
  if (isCloseVisible) await close.click();
  await page.getByTestId(`gate-${choice}-${stepId}`).click();
  if (choice === "reject" && reason) {
    // The reason input only appears once the gate is staged "reject".
    const field = page.getByTestId(`gate-reason-${stepId}`);
    await field.waitFor();
    await field.fill(reason);
  }
  const submit = page.getByTestId("submit-decisions");
  await expect(submit).toBeEnabled();
  await submit.click();
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // The app opens on the "Build the workflow" tab; the pipeline lives behind the
  // "Run it on invoices" tab. Switch to it, then the seeded queue must be visible
  // (not the "needs its database" notice, if this fails, the backend env isn't set).
  await page.getByRole("button", { name: /Run it on invoices/ }).click();
  await expect(page.getByText("Invoice queue")).toBeVisible();
});

test("clean invoice runs straight through, no approval gate", async ({ page }) => {
  await selectAndRun(page, "INV-2040");

  // A clean invoice trips no gate, so the decision bar never appears.
  await expect(page.getByTestId("approval-gate")).toHaveCount(0, {
    timeout: RUN_TIMEOUT,
  });
  // Open the trace: reconciliation resolves to ok (posted).
  await openTrace(page);
  await expect(step(page, "reconciliation")).toHaveAttribute("data-status", "ok", {
    timeout: RUN_TIMEOUT,
  });
  await expect(page.getByText("Pipeline complete")).toBeVisible();
});

test("price-mismatch pauses for approval, then APPROVE posts it", async ({ page }) => {
  await selectAndRun(page, "INV-2042");

  // 1. The run PAUSES on the manager gate: the decision bar appears on the canvas.
  await expect(page.getByTestId("approval-gate")).toBeVisible({
    timeout: RUN_TIMEOUT,
  });

  // 2. Open the trace: matching caught the variance (amber), reconciliation waits,
  //    and nothing posted yet.
  await openTrace(page);
  await expect(step(page, "matching")).toHaveAttribute("data-status", "warn");
  await expect(step(page, "reconciliation")).toHaveAttribute("data-status", "waiting");
  await expect(page.getByText(/Paused/)).toBeVisible();
  await expect(page.getByText(/NETSUITE-BILL-/)).toHaveCount(0);

  // 3. Approve the gate on its node + submit → reconciliation posts, bar disappears.
  await decideGate(page, "manager-review", "approve");
  await expect(page.getByTestId("approval-gate")).toHaveCount(0, {
    timeout: RUN_TIMEOUT,
  });
  await openTrace(page);
  await expect(step(page, "reconciliation")).toHaveAttribute("data-status", "ok", {
    timeout: RUN_TIMEOUT,
  });
  await expect(page.getByText(/NETSUITE-BILL-/).first()).toBeVisible();

  // 4. No duplicated stage nodes after the resume (the audit-bug guard: a phase-2
  //    resume must upsert the stages in place, not stack a second set).
  await expect(page.getByTestId("intake-collapsed")).toHaveCount(1);
  await expect(step(page, "matching")).toHaveCount(1);
  await expect(step(page, "approval")).toHaveCount(1);
  await expect(step(page, "reconciliation")).toHaveCount(1);
  await expect(page.getByText("Pipeline started")).toHaveCount(0);
});

test("price-mismatch REJECT (with a reason) leaves it un-posted", async ({ page }) => {
  await selectAndRun(page, "INV-2042");

  await expect(page.getByTestId("approval-gate")).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  // Reject the gate on its node with a reason, then submit.
  await decideGate(page, "manager-review", "reject", "price too high, renegotiate");

  // Reconciliation ends in error (rejected), and nothing was posted.
  await openTrace(page);
  await expect(step(page, "reconciliation")).toHaveAttribute("data-status", "error", {
    timeout: RUN_TIMEOUT,
  });
  await expect(page.getByText(/NETSUITE-BILL-/)).toHaveCount(0);
  // The reason rides into the trace on the rejected gate's detail.
  await expect(page.getByText(/price too high, renegotiate/).first()).toBeVisible();
});
