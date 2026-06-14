import { SEED_BUNDLES, type SeedBundle } from "@/db/seed-data";
import { runMatch } from "@/lib/matching";
import { routeApproval } from "@/lib/policy";
import { reconcile } from "@/lib/erp";
import { PIPELINE_MODEL } from "./model";

/**
 * Pipeline sanity check — `tsx src/mastra/sanity.ts [--dry-run]`.
 *
 * In `--dry-run` mode (the default in CI) it runs the DETERMINISTIC pipeline
 * path — the exact runMatch → routeApproval → reconcile functions the Mastra
 * steps use — over every seeded invoice, prints the routing each takes, and
 * exits non-zero if the three headline edge cases don't land on their intended
 * verdicts. This validates the orchestration logic offline, with NO LLM calls
 * (no key, no tokens) — safe to run in CI.
 *
 * Without `--dry-run` it would additionally exercise the live agents; that path
 * needs ANTHROPIC_API_KEY and is intentionally NOT run in CI. (The streaming
 * route is the real end-to-end exercise of the agents.)
 */

const DRY_RUN = process.argv.includes("--dry-run");

function ledgerFor(bundle: SeedBundle): string[] {
  const idx = SEED_BUNDLES.indexOf(bundle);
  return SEED_BUNDLES.slice(0, idx).map((b) => b.invoice.invoiceNumber);
}

async function routeOf(bundle: SeedBundle, humanApproval: "pending" | "approve" | "reject" = "pending") {
  const match = runMatch({
    invoice: bundle.invoice,
    purchaseOrder: bundle.purchaseOrder ?? null,
    goodsReceipt: bundle.goodsReceipt ?? null,
    priorInvoiceNumbers: ledgerFor(bundle),
  });
  const decision = routeApproval(match);
  const recon = await reconcile(decision, match, bundle.invoice.vendor, humanApproval);
  return { match, decision, recon };
}

async function main() {
  console.log(`ledgerloop pipeline sanity — model: ${PIPELINE_MODEL}`);
  console.log(DRY_RUN ? "mode: dry-run (deterministic, no LLM)\n" : "mode: full\n");

  if (!DRY_RUN && !process.env.ANTHROPIC_API_KEY) {
    console.error("✖ Full mode needs ANTHROPIC_API_KEY. Use --dry-run for the offline check.");
    process.exit(1);
  }

  const rows: string[] = [];
  let failures = 0;

  for (const b of SEED_BUNDLES) {
    const { match, decision, recon } = await routeOf(b); // pending: shows the pause
    const route =
      decision.tier === "auto"
        ? `straight-through → posted (${recon.erpRef})`
        : decision.tier === "blocked"
          ? "BLOCKED (not posted)"
          : `→ ${decision.tier} approval → ⏸ awaiting human decision`;
    rows.push(`  ${b.invoice.invoiceNumber.padEnd(16)} ${match.verdict.padEnd(10)} ${route}`);
  }

  console.log("Invoice          Verdict    Routing (humanApproval = pending)");
  console.log(rows.join("\n"));
  console.log();

  // Assert the headline edge cases route as the demo promises.
  const expect: Array<[string, "clean" | "exception" | "duplicate"]> = [
    ["INV-2042", "exception"], // price mismatch
    ["INV-2048", "exception"], // quantity mismatch
    ["INV-2041-RESEND", "duplicate"], // duplicate
  ];
  for (const [id, want] of expect) {
    const bundle = SEED_BUNDLES.find((b) => b.id === id);
    if (!bundle) {
      console.error(`✖ missing seed bundle ${id}`);
      failures++;
      continue;
    }
    const { match } = await routeOf(bundle);
    if (match.verdict !== want) {
      console.error(`✖ ${id}: expected ${want}, got ${match.verdict}`);
      failures++;
    }
  }

  // Assert the human-in-the-loop gate actually gates: a price-mismatch exception
  // must PAUSE when pending, POST only after approval, and stay un-posted on reject.
  const priceMismatch = SEED_BUNDLES.find((b) => b.id === "INV-2042");
  if (priceMismatch) {
    const pending = (await routeOf(priceMismatch, "pending")).recon;
    const approved = (await routeOf(priceMismatch, "approve")).recon;
    const rejected = (await routeOf(priceMismatch, "reject")).recon;
    if (pending.outcome !== "awaiting" || pending.posted) {
      console.error(`✖ INV-2042 pending: expected awaiting/un-posted, got ${pending.outcome}`);
      failures++;
    }
    if (approved.outcome !== "posted" || !approved.posted) {
      console.error(`✖ INV-2042 approve: expected posted, got ${approved.outcome}`);
      failures++;
    }
    if (rejected.outcome !== "rejected" || rejected.posted) {
      console.error(`✖ INV-2042 reject: expected rejected/un-posted, got ${rejected.outcome}`);
      failures++;
    }
    if (!failures) {
      console.log(
        "✓ Human-in-the-loop gate: INV-2042 pauses (awaiting) → posts on approve → stays un-posted on reject.",
      );
    }
  }

  if (failures > 0) {
    console.error(`\n✖ ${failures} sanity check(s) failed.`);
    process.exit(1);
  }
  console.log("✓ All edge cases route as expected. Pipeline logic is sound.");
}

main().catch((err) => {
  console.error("✖ Sanity check crashed:", err);
  process.exit(1);
});
