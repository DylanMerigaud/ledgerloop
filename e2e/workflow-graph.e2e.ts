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

/** The center Y of a node's source (right/bottom) and target (left/top) handle, read
    from the rendered DOM within a given case container. For a straight edge the
    source's Y and the target's Y must match; a mismatch is the stair-step "kink" (a
    node's center, and thus its handle, sitting off because its card is a different
    height). Scoped to `caseId` so a page with several sub-canvases is unambiguous. */
const handleY = async (page: Page, caseId: string, stepId: string) => {
  return page.evaluate(
    ({ caseId, stepId }) => {
      const node = document
        .querySelector(`[data-testid="${caseId}"]`)
        ?.querySelector(`[data-testid="graph-node-${stepId}"]`)
        ?.closest(".react-flow__node");
      const mid = (sel: string): number | null => {
        const r = node?.querySelector(sel)?.getBoundingClientRect();
        return r ? Math.round(r.y + r.height / 2) : null;
      };
      return {
        src:
          mid(".react-flow__handle-right") ?? mid(".react-flow__handle-bottom"),
        tgt: mid(".react-flow__handle-left") ?? mid(".react-flow__handle-top"),
      };
    },
    { caseId, stepId },
  );
};

// The layout cases are rendered deterministically (no model) at /dev/graph-cases, so
// these assert the RENDERED handle geometry across the shapes that used to kink.
test.describe("graph layout: handles never kink", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/dev/graph-cases");
    // Wait for all three sub-canvases to have laid out (their post nodes are visible).
    await expect(
      page.locator(
        '[data-testid="case-linear"] [data-testid="graph-node-post-netsuite"]',
      ),
    ).toBeVisible();
    await page.waitForTimeout(700); // let any measured-height re-layout settle
  });

  test("linear chain: a Manager → Post run graph is dead straight", async ({
    page,
  }) => {
    // Different-height nodes on one line (tall gate → short integration). The straighten
    // pass snaps the target's center onto the source's, so the two handles share a Y.
    const mgr = await handleY(page, "case-linear", "manager-review");
    const post = await handleY(page, "case-linear", "post-netsuite");
    expect(mgr.src, "manager source handle").not.toBeNull();
    expect(post.tgt, "post target handle").not.toBeNull();
    expect(Math.abs((mgr.src ?? 0) - (post.tgt ?? 0))).toBeLessThanOrEqual(2);
  });

  test("fan-out: branches straddle a straight Manager ↔ Post spine", async ({
    page,
  }) => {
    // Manager → {Director, Dept} → Post: manager and post stay colinear (the spine),
    // and the two branches sit symmetrically above/below it.
    const mgr = await handleY(page, "case-fanout", "manager-review");
    const post = await handleY(page, "case-fanout", "post-netsuite");
    const dir = await handleY(page, "case-fanout", "director-review");
    const dept = await handleY(page, "case-fanout", "dept-review");
    expect(Math.abs((mgr.src ?? 0) - (post.tgt ?? 0))).toBeLessThanOrEqual(2);
    const spine = mgr.src ?? 0;
    const above = spine - (dir.tgt ?? 0);
    const below = (dept.tgt ?? 0) - spine;
    expect(above, "director above the spine").toBeGreaterThan(0);
    expect(below, "dept below the spine").toBeGreaterThan(0);
    expect(Math.abs(above - below), "symmetric fan-out").toBeLessThanOrEqual(8);
  });

  test("base workflow with a condition: the diamond renders without a big kink", async ({
    page,
  }) => {
    // The base workflow is Manager → {Director, Post}: a conditional escalation to
    // Director plus a direct fall-through to Post. It's a real branch (not a straight
    // line), so a small bend is fine, but no node should be wildly off the spine.
    const mgr = await handleY(page, "case-diamond", "manager-review");
    const dir = await handleY(page, "case-diamond", "director-review");
    const post = await handleY(page, "case-diamond", "post-netsuite");
    expect(mgr.src, "manager present").not.toBeNull();
    expect(
      dir.tgt,
      "director present (base keeps the escalation gate)",
    ).not.toBeNull();
    expect(post.tgt, "post present").not.toBeNull();
    // Manager, Director and Post sit within a modest band (a card-height's worth), i.e.
    // the diamond stays a tidy near-line, not a staircase.
    const ys = [mgr.src ?? 0, dir.tgt ?? 0, post.tgt ?? 0];
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThanOrEqual(40);
  });
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
