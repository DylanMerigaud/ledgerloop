import { test, expect, type Page } from "@playwright/test";

/**
 * Per-gate approve/reject across a PARALLEL wave, end to end in the real browser.
 *
 * The derived (onboarding) workflow has two first-line roots — manager review and
 * department review — so an invoice that is BOTH an exception AND a Product PO pends
 * both gates at once. INV-2051 is exactly that. This test proves you can decide each
 * gate independently on its node and that a mixed wave (reject one, approve the other)
 * blocks the bill — reject wins.
 *
 * Needs ANTHROPIC_API_KEY + DATABASE_URL (discovery runs the onboarding agent), so it
 * is NOT in CI — run `pnpm e2e` locally with .env loaded. The recorded HRIS fixture is
 * fine (no BambooHR keys required).
 */

const DISCOVERY_TIMEOUT = 90_000;
const RUN_TIMEOUT = 30_000;

const node = (page: Page, id: string) =>
  page.getByTestId("live-graph").getByTestId(`graph-node-${id}`);

const step = (page: Page, stage: string) =>
  page.locator(`[data-testid="trace-step-${stage}"]`);

test("two parallel gates: reject one, approve the other → bill blocked", async ({
  page,
}) => {
  await page.goto("/");

  // 1. Derive the workflow from the org (parallel roots: manager + department).
  await page.getByRole("button", { name: /Discover from BambooHR/ }).click();
  await expect(page.getByText(/Route by department/)).toBeVisible({
    timeout: DISCOVERY_TIMEOUT,
  });

  // 2. Run INV-2051 (exception + Product) on the pipeline.
  await page.getByRole("button", { name: /Run it on invoices/ }).click();
  await page.getByTestId("queue-row-INV-2051").click();
  await page.getByTestId("run-btn").click();

  // 3. The run pauses with BOTH gates pending, each showing inline controls.
  await expect(step(page, "reconciliation")).toHaveAttribute(
    "data-status",
    "waiting",
    { timeout: RUN_TIMEOUT },
  );
  await expect(page.getByTestId("approval-gate-multi")).toBeVisible();
  await expect(node(page, "manager-review")).toBeVisible();
  await expect(node(page, "department-review")).toBeVisible();
  // Nothing posted yet.
  await expect(page.getByText(/NETSUITE-BILL-/)).toHaveCount(0);

  // 4. Decide each gate independently: reject manager, approve department.
  await node(page, "manager-review")
    .getByTestId("gate-reject-manager-review")
    .click();
  await node(page, "department-review")
    .getByTestId("gate-approve-department-review")
    .click();

  // 5. Submit the wave → the bill is BLOCKED (reject wins), nothing posts.
  await page.getByTestId("submit-decisions").click();
  await expect(step(page, "reconciliation")).toHaveAttribute(
    "data-status",
    "error",
    { timeout: RUN_TIMEOUT },
  );
  await expect(page.getByText(/NETSUITE-BILL-/)).toHaveCount(0);
});
