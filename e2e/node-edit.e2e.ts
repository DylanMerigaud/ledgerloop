import { test, expect, type Page } from "@playwright/test";

/**
 * The node editor (the Pivot-style side panel): in onboarding, clicking a gate in
 * the graph opens a panel that edits THAT step directly, the approver picker (which
 * resolves an unresolved gate), the threshold, the label, remove. In the pipeline the
 * graph is read-only (clicking a node does nothing). Needs ANTHROPIC_API_KEY +
 * DATABASE_URL (discovery), so it's local-only (`pnpm e2e`); recorded HRIS is fine.
 */

const DISCOVERY_TIMEOUT = 90_000;

// Both tabs stay mounted and share the derived workflow, so a node id exists in the
// (hidden) pipeline graph too. Scope to the VISIBLE one (the onboarding editor here).
const node = (page: Page, id: string) =>
  page.getByTestId(`graph-node-${id}`).locator("visible=true");

test("clicking a gate opens the panel and the approver picker resolves it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Discover from BambooHR/ }).click();
  // Discovery done once the derived workflow has rendered its gates.
  await expect(node(page, "manager-review")).toBeVisible({
    timeout: DISCOVERY_TIMEOUT,
  });

  // Click the manager-review gate → the panel opens for that step (the trigger editor).
  await node(page, "manager-review").click();
  await expect(page.getByText(/Triggers when/)).toBeVisible();

  // The department-review gate is often unresolved by the model, open it and assign
  // a person via the approver combobox; the node's "unresolved" warning then clears.
  await node(page, "department-review").click();
  await page.getByTestId("approver-combobox").click();
  // Pick the first person in the open list.
  await page.locator('[role="option"]').first().click();
  // The chosen person now shows on the department gate (no more "unresolved").
  await expect(node(page, "department-review").getByText("unresolved")).toHaveCount(0);
});

test("the pipeline graph is read-only, clicking a node does nothing", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Run it on invoices/ }).click();
  await page.getByTestId("queue-row-INV-2042").click();
  await page.getByTestId("run-btn").click();
  // The pipeline graph (the hero pane) is read-only: clicking a node does NOT open
  // the editor (that's an onboarding-only affordance).
  const liveNode = page.getByTestId("graph-pane").getByTestId("graph-node-manager-review");
  await expect(liveNode).toBeVisible({ timeout: 45_000 });
  await liveNode.click();
  await expect(page.getByText(/Triggers when/)).toHaveCount(0);
});
