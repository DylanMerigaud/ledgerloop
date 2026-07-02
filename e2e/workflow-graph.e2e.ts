import { test, expect, type Page } from "@playwright/test";

/**
 * Graphical checks on the workflow canvas, driven through the REAL browser. The
 * layout/handle logic is the kind of thing screenshots keep getting wrong, so these
 * assert the RENDERED DOM: no dangling connector stubs (a leaf has no outgoing
 * handle, a root has no incoming one), and the run graph is the LINEAR path the
 * invoice took (skipped conditional gates are pruned, not drawn as an ambiguous
 * diamond).
 *
 * Needs ANTHROPIC_API_KEY + DATABASE_URL, so it is NOT run in CI, run `pnpm e2e`
 * locally with .env loaded.
 *
 * Seeded rows:
 *   INV-2040 , clean 3-way match (straight-through)
 *   INV-2042 , price mismatch (routes to the manager gate)
 */

const RUN_TIMEOUT = 45_000;

/** Handle counts on a node, split by direction. React Flow renders each Handle as
    `.react-flow__handle-{left|right|top|bottom}`; horizontally, target=left,
    source=right. We sum both orientations so the test is layout-agnostic. */
const handleCounts = async (page: Page, stepId: string) => {
  return page.evaluate((id) => {
    const node = document
      .querySelector(`[data-testid="graph-node-${id}"]`)
      ?.closest(".react-flow__node");
    const n = (dir: string) =>
      node ? node.querySelectorAll(`.react-flow__handle-${dir}`).length : -1;
    return {
      incoming: n("left") + n("top"),
      outgoing: n("right") + n("bottom"),
    };
  }, stepId);
};

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Run it on invoices/ }).click();
  await expect(page.getByText("Invoice queue")).toBeVisible();
});

test("run graph: no dangling handles (leaf has no source, root has no target)", async ({
  page,
}) => {
  // A clean invoice posts straight through, so the graph settles on its realized
  // path with the terminal integration node visible.
  await page.getByTestId("queue-row-INV-2040").click();
  await page.getByTestId("run-btn").click();

  // Wait for the lit graph: the terminal "Post" node is present once approval routing
  // has run. It's the leaf, so it must have an incoming edge but NO outgoing handle.
  const post = page.getByTestId("graph-node-post-netsuite");
  await expect(post).toBeVisible({ timeout: RUN_TIMEOUT });

  const postH = await handleCounts(page, "post-netsuite");
  expect(postH.outgoing).toBe(0); // terminal: no dangling right/bottom stub
  expect(postH.incoming).toBe(1); // it IS reached

  // The root gate (whatever the run entered on) has an outgoing edge but no incoming
  // handle. Find the first node with zero incoming edges in the rendered graph.
  const roots = await page.evaluate(() => {
    const nodes = [
      ...document.querySelectorAll('[data-testid^="graph-node-"]'),
    ];
    return nodes
      .map((el) => {
        const wrap = el.closest(".react-flow__node");
        const inc = wrap
          ? wrap.querySelectorAll(
              ".react-flow__handle-left,.react-flow__handle-top",
            ).length
          : 0;
        const out = wrap
          ? wrap.querySelectorAll(
              ".react-flow__handle-right,.react-flow__handle-bottom",
            ).length
          : 0;
        return { inc, out };
      })
      .filter((h) => h.inc === 0);
  });
  // At least one root, and every root with no incoming edge also has an outgoing one
  // (it's not an orphan) and crucially NO incoming handle stub.
  expect(roots.length).toBeGreaterThanOrEqual(1);
  for (const r of roots) expect(r.out).toBeGreaterThanOrEqual(1);
});

test("run graph: the skipped conditional gate is pruned to a linear path", async ({
  page,
}) => {
  // INV-2042 trips the manager gate but stays under the director-escalation
  // threshold, so the director gate is SKIPPED. The realized path prunes it: the
  // director node must NOT be in the rendered graph, leaving a clean linear chain.
  await page.getByTestId("queue-row-INV-2042").click();
  await page.getByTestId("run-btn").click();

  // Wait until approval routing has produced the graph (the manager gate pauses).
  await expect(page.getByTestId("approval-gate")).toBeVisible({
    timeout: RUN_TIMEOUT,
  });

  // The manager gate is present (it's on the path); the director gate is not (it was
  // skipped, so the pruned graph drops it rather than drawing an ambiguous branch).
  await expect(page.getByTestId("graph-node-manager-review")).toBeVisible();
  await expect(page.getByTestId("graph-node-director-review")).toHaveCount(0);
});
