import { test, expect } from "@playwright/test";

/**
 * The conversational editor's discoverability + clarifying turn, through the real
 * browser + the live edit model.
 *
 * After discovery the editor shows the org's REAL departments as chips. An ambiguous
 * instruction ("add a department review", no department named) makes the agent ask
 * which one instead of inventing a dead gate — the clarifying turn the model chooses
 * only when a slot is missing. Picking an option completes the instruction and the
 * gate is proposed. Needs ANTHROPIC_API_KEY + DATABASE_URL (discovery + edit model),
 * so it's local-only (`pnpm e2e`), recorded HRIS (BAMBOO_HR_API_KEY= unset) is fine.
 */

const DISCOVERY_TIMEOUT = 90_000;
const EDIT_TIMEOUT = 45_000;

test("an ambiguous department edit asks which one, then applies the pick", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Discover from BambooHR/ }).click();

  // Discovery done once the derived workflow has rendered its gates.
  await expect(page.getByTestId("graph-node-manager-review")).toBeVisible({
    timeout: DISCOVERY_TIMEOUT,
  });

  // Ambiguous instruction → the agent asks which department (it must NOT guess).
  await page
    .getByPlaceholder(/Describe a change/)
    .fill("add a department review");
  await page.getByRole("button", { name: /^Edit$/ }).click();
  await expect(page.getByText(/which department/i)).toBeVisible({
    timeout: EDIT_TIMEOUT,
  });

  // Pick Finance from the clarification options → it completes the instruction and
  // proposes a Finance-scoped gate (the diff bar appears).
  await page.getByRole("button", { name: "Finance" }).last().click();
  await expect(page.getByText(/not applied yet/i)).toBeVisible({
    timeout: EDIT_TIMEOUT,
  });
  // The proposed graph mentions Finance (the new gate's department scope).
  await expect(page.getByText(/Finance/).first()).toBeVisible();
});
