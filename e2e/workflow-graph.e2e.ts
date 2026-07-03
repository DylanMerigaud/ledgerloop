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
    from the rendered DOM. For a straight edge the source's Y and the target's Y must
    match; a mismatch is the stair-step "kink" (a node whose measured height drifted
    after layout so its center, and thus its handle, sits a few px off). */
const handleY = async (page: Page, stepId: string) => {
  return page.evaluate((id) => {
    const node = document
      .querySelector(`[data-testid="graph-node-${id}"]`)
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
  }, stepId);
};

test("layout: spine handles stay aligned after nodes resize (no edge kink)", async ({
  page,
}) => {
  // The onboarding EMPTY STATE renders the sample workflow (manager → {director, dept}
  // → post) with NO model call, so this is deterministic. Manager and Post sit on the
  // spine; a fan-out node (director) carries a taller `when` chip. The fix re-lays-out
  // when a node's measured height drifts after the one-shot layout, so the spine
  // handles must line up: manager's source Y == post's target Y (within a hair).
  await page.getByRole("button", { name: /Build the workflow/ }).click();
  await expect(page.getByTestId("graph-node-manager")).toBeVisible();
  await expect(page.getByTestId("graph-node-post")).toBeVisible();

  // Give the drift re-layout a beat to settle (the fix runs an extra pass when a
  // when-chip/font finishes measuring a few px taller than the first layout used).
  await page.waitForTimeout(600);

  const mgr = await handleY(page, "manager");
  const post = await handleY(page, "post");
  expect(mgr.src, "manager has a source handle").not.toBeNull();
  expect(post.tgt, "post has a target handle").not.toBeNull();
  // Manager → ... → Post is the spine: the two ends line up (≤ 2px), so the connector
  // is straight, not a Z-kink.
  expect(Math.abs((mgr.src ?? 0) - (post.tgt ?? 0))).toBeLessThanOrEqual(2);

  // And the fan-out is symmetric around that spine: director (top) and dept (bottom)
  // straddle the manager/post line, each roughly equidistant, so a resized node didn't
  // shove the group off-center.
  const dir = await handleY(page, "director");
  const dept = await handleY(page, "dept");
  const spine = mgr.src ?? 0;
  const above = spine - (dir.tgt ?? 0);
  const below = (dept.tgt ?? 0) - spine;
  expect(above, "director sits above the spine").toBeGreaterThan(0);
  expect(below, "dept sits below the spine").toBeGreaterThan(0);
  // Symmetric within a node-height's slack (heights can differ a little).
  expect(Math.abs(above - below)).toBeLessThanOrEqual(60);
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
