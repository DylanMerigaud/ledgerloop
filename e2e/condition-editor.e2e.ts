import { test, expect, type Page } from "@playwright/test";

/**
 * The condition editor in the node panel: click a gate in the onboarding graph and edit
 * its trigger as a 2-level ALL/ANY tree, deterministically (no model). Needs
 * ANTHROPIC_API_KEY + DATABASE_URL for the one discovery call; the editing itself is
 * client-side. Local-only (`pnpm e2e`); recorded HRIS is fine.
 */

const DISCOVERY_TIMEOUT = 90_000;

const node = (page: Page, id: string) => page.getByTestId(`graph-node-${id}`);

test("edit a gate's trigger: add a condition and a nested group", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Discover from BambooHR/ }).click();
  await expect(page.getByText(/Route by department/)).toBeVisible({
    timeout: DISCOVERY_TIMEOUT,
  });

  // Open the manager gate → the condition editor shows its current trigger.
  await node(page, "manager-review").click();
  await expect(page.getByTestId("cond-combinator").first()).toBeVisible();

  const fieldCount = () => page.getByTestId("cond-field").count();
  const before = await fieldCount();

  // Add a flat condition → one more leaf row.
  await page.getByTestId("cond-add-leaf").click();
  await expect(async () =>
    expect(await fieldCount()).toBe(before + 1),
  ).toPass();

  // Add a nested group → its own leaf row appears (the depth-2 group).
  await page.getByTestId("cond-add-group").click();
  await expect(page.getByTestId("cond-subadd-leaf")).toBeVisible();
  await expect(async () =>
    expect(await fieldCount()).toBe(before + 2),
  ).toPass();

  // Switch the root combinator to ANY — the node's plain-English chip recomputes
  // (an "or" rule), proving the edit flowed through set-condition to the graph.
  await page.getByTestId("cond-combinator").first().selectOption("any");
  await expect(node(page, "manager-review").getByText(/ or /)).toBeVisible();
});
