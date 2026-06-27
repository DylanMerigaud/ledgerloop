import { test, expect } from "@playwright/test";

/**
 * The conversational editor can route on the richer levers (vendor / currency /
 * match type / exception code), through the real browser + live edit model. We
 * exercise the vendor lever: it's the most AP-meaningful and the value comes from a
 * real seeded invoice (Severn Steelworks, INV-2042). The model receives the present
 * vendors and matches a partial name; an unknown vendor would be declined, not
 * invented. Needs ANTHROPIC_API_KEY + DATABASE_URL, so it's local-only (`pnpm e2e`).
 */

const DISCOVERY_TIMEOUT = 90_000;
const EDIT_TIMEOUT = 45_000;

test("the editor builds a vendor-scoped gate from a plain instruction", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Discover from BambooHR/ }).click();
  // Discovery done once the derived workflow has rendered its gates.
  await expect(page.getByTestId("graph-node-manager-review")).toBeVisible({
    timeout: DISCOVERY_TIMEOUT,
  });

  // The "what can I change" doc lists the levers + the real values present. The
  // currency list is short, so assert it (the vendor list is long and truncated).
  await page.getByRole("button", { name: /What can I change/ }).click();
  await expect(page.getByText(/Route on any of these/)).toBeVisible();
  await expect(page.getByText(/EUR, GBP, USD/)).toBeVisible();
  // Close the popover (click the toggle again).
  await page.getByRole("button", { name: /What can I change/ }).click();

  // Ask for a vendor-scoped review (partial name → the model resolves the full one).
  await page
    .getByPlaceholder(/Describe a change/)
    .fill("require a contract review for Severn Steelworks bills");
  await page.getByRole("button", { name: /^Edit$/ }).click();

  // A proposal appears (the diff bar) and the new gate is scoped to the vendor.
  await expect(page.getByText(/not applied yet/i)).toBeVisible({
    timeout: EDIT_TIMEOUT,
  });
  await expect(
    page.getByText(/Vendor: Severn Steelworks/).first(),
  ).toBeVisible();
});
