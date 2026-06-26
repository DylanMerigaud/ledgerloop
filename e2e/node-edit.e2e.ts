import { test, expect, type Page } from "@playwright/test";

/**
 * The node editor (the Pivot-style side panel): in onboarding, clicking a gate in
 * the graph opens a panel that edits THAT step directly — the approver picker (which
 * resolves an unresolved gate), the threshold, the label, remove. In the pipeline the
 * graph is read-only (clicking a node does nothing). Needs ANTHROPIC_API_KEY +
 * DATABASE_URL (discovery), so it's local-only (`pnpm e2e`); recorded HRIS is fine.
 */

const DISCOVERY_TIMEOUT = 90_000;

const node = (page: Page, id: string) => page.getByTestId(`graph-node-${id}`);

test("clicking a gate opens the panel and the approver picker resolves it", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Discover from BambooHR/ }).click();
  await expect(page.getByText(/Route by department/)).toBeVisible({
    timeout: DISCOVERY_TIMEOUT,
  });

  // Click the manager-review gate → the panel opens for that step.
  await node(page, "manager-review").click();
  await expect(page.getByText(/Triggers when amount over/)).toBeVisible();

  // The department-review gate is often unresolved by the model — open it and assign
  // a person via the picker; the node's "unresolved" warning then clears.
  await node(page, "department-review").click();
  const picker = page.locator("select").first();
  await expect(picker).toBeVisible();
  // Pick the first real person in the list.
  const firstPerson = await picker
    .locator("option:not([disabled])")
    .first()
    .getAttribute("value");
  await picker.selectOption(firstPerson);
  // The chosen person now shows on the department gate (no more "unresolved").
  await expect(
    node(page, "department-review").getByText("unresolved"),
  ).toHaveCount(0);
});

test("the pipeline graph is read-only — clicking a node does nothing", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Run it on invoices/ }).click();
  await page.getByTestId("queue-row-INV-2042").click();
  await page.getByTestId("run-btn").click();
  // Scope to the live routing graph (the trace timeline draws the same nodes lower
  // down, so the bare testid isn't unique on this screen).
  const liveNode = page
    .getByTestId("live-graph")
    .getByTestId("graph-node-manager-review");
  await expect(liveNode).toBeVisible({ timeout: 40_000 });
  await liveNode.click();
  // No edit panel appears in the pipeline (the panel's hallmark field is absent).
  await expect(page.getByText(/Triggers when amount over/)).toHaveCount(0);
});
