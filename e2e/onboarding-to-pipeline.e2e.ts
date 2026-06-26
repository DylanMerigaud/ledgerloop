import { test, expect, type Page } from "@playwright/test";

/**
 * The flagship loop, through the REAL browser + backend: derive a workflow from the
 * HRIS, switch to the pipeline, and confirm an invoice routes through THAT workflow
 * — specifically the department gate, which only exists in the derived workflow.
 *
 * This is the parcours most likely to regress (shared state across the two tabs, the
 * activated workflow flowing into the run), and the one the unit tests can't cover —
 * it needs the discovery model + the streamed run as a user drives them. Like
 * approval.e2e.ts it needs ANTHROPIC_API_KEY + DATABASE_URL, so it's local-only
 * (`pnpm e2e`), not CI.
 *
 * Recorded HRIS is fine (and faster): run with BAMBOO_HR_API_KEY= unset and onboarding
 * replays the committed fixture. INV-2044's PO is department "Product", and the derived
 * template gates a "Department head review" on department == Product, so the run pauses
 * on that gate (in parallel with the manager) even though the invoice is a clean match.
 */

const DISCOVERY_TIMEOUT = 90_000; // a live discovery model call + assembly
const RUN_TIMEOUT = 40_000;

const step = (page: Page, stage: string) =>
  page.locator(`[data-testid="trace-step-${stage}"]`);

test("a derived workflow drives the run, department gate and all", async ({
  page,
}) => {
  await page.goto("/");

  // 1. Discover from the HRIS (recorded fixture) on the "Build the workflow" tab.
  await page.getByRole("button", { name: /Discover from BambooHR/ }).click();
  // The derived workflow shows its department-review gate.
  await expect(page.getByText(/Department head review/).first()).toBeVisible({
    timeout: DISCOVERY_TIMEOUT,
  });

  // 2. Switch to the pipeline. The banner names the DERIVED workflow (not the
  //    default), which proves the activated workflow reached this tab.
  await page.getByRole("button", { name: /Run it on invoices/ }).click();
  await expect(page.getByText(/Running against/)).toBeVisible();

  // 3. Switch BACK to onboarding and forward again — the discovery must SURVIVE the
  //    tab switch (both tabs stay mounted). If it reset, the editor would be empty.
  await page.getByRole("button", { name: /Build the workflow/ }).click();
  await expect(page.getByText(/Department head review/).first()).toBeVisible();
  await page.getByRole("button", { name: /Run it on invoices/ }).click();

  // 4. Run INV-2044 (clean, PO department = Product). A clean invoice under the
  //    manager floor would post straight through — but the Product department gate
  //    fires, so it PAUSES.
  await page.getByTestId("queue-row-INV-2044").click();
  await page.getByTestId("run-btn").click();
  await expect(page.getByTestId("approval-gate")).toBeVisible({
    timeout: RUN_TIMEOUT,
  });
  // The pending narration names the department gate — proof it's the derived
  // workflow's Product gate that fired, not a generic default.
  await expect(page.getByText(/department == Product/)).toBeVisible();

  // 5. One Approve clears the first-wave gates → it posts.
  await page.getByTestId("approve-btn").click();
  await expect(step(page, "reconciliation")).toHaveAttribute(
    "data-status",
    "ok",
    { timeout: RUN_TIMEOUT },
  );
  await expect(page.getByTestId("approval-gate")).toHaveCount(0);
});
