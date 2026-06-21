/**
 * Investigator eval harness — `tsx eval/run.ts [--dry-run] [caseId ...]`.
 *
 *   pnpm eval              # run every case against the REAL agent
 *   pnpm eval INV-2042     # run only the named case(s)
 *   pnpm eval --dry-run    # validate the harness offline, no API calls
 *
 * For each case it computes the deterministic match (the same `runMatch` the
 * pipeline uses), runs the REAL investigator agent over it (the same
 * `lib/investigation.ts` the workflow uses), and scores the agent's
 * recommendation against the ground truth in `eval/cases.ts`:
 *   • overall accuracy
 *   • overcharge precision / recall / F1 (catching the invoices to push back on)
 *
 * This is what proves the AGENT's judgment holds across mixed exceptions — not
 * just that the deterministic routing fires (that's `pnpm sanity`).
 *
 * Needs ANTHROPIC_API_KEY (loaded from .env.local / .env); each case is one
 * agent run, a few cents for the whole set. `--dry-run` stubs the agent with the
 * ground-truth label so the scoring + corpus are exercised with zero API calls
 * (a perfect score is the expected dry-run output) — what CI runs.
 */

import { join } from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { mastra } from "@/src/mastra";
import { PIPELINE_MODEL } from "@/src/mastra/model";
import { SEED_BUNDLES, type SeedBundle } from "@/db/seed-data";
import { runMatch } from "@/lib/matching";
import {
  runInvestigation,
  INVESTIGATION_CTX_KEY,
  type InvestigatorAgent,
} from "@/lib/investigation";
import { EVAL_CASES, type EvalCase } from "./cases";
import {
  scoreCase,
  accuracy,
  overchargeConfusion,
  type CaseScore,
  type Recommendation,
} from "./score";

// ── ANSI helpers (no dependency) ────────────────────────────────────────────
const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};
const useColor = process.stdout.isTTY;
const col = (code: string, s: string) =>
  useColor ? `${code}${s}${C.reset}` : s;

function loadEnv() {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(join(process.cwd(), f));
    } catch {
      /* file absent — fine */
    }
  }
}

/** Prior invoice numbers for duplicate detection — everything seeded before it. */
function priorNumbersFor(bundle: SeedBundle): string[] {
  const idx = SEED_BUNDLES.indexOf(bundle);
  return SEED_BUNDLES.slice(0, idx).map((b) => b.invoice.invoiceNumber);
}

async function runOneCase(c: EvalCase, dryRun: boolean): Promise<CaseScore> {
  const bundle = SEED_BUNDLES.find((b) => b.id === c.id);
  if (!bundle) {
    return scoreCase(c.id, c.stresses, c.expected, undefined, "no seed bundle");
  }

  const match = runMatch({
    invoice: bundle.invoice,
    purchaseOrder: bundle.purchaseOrder ?? null,
    goodsReceipt: bundle.goodsReceipt ?? null,
    priorInvoiceNumbers: priorNumbersFor(bundle),
  });

  // Sanity: the corpus should only contain real exceptions (otherwise the agent
  // never runs and the case is meaningless).
  if (match.verdict !== "exception") {
    return scoreCase(
      c.id,
      c.stresses,
      c.expected,
      undefined,
      `not an exception (verdict: ${match.verdict})`,
    );
  }

  // --dry-run: skip the model, "predict" the ground truth verbatim. Exercises the
  // match + scoring + reporting path with no API call; a perfect run is expected.
  if (dryRun) {
    return scoreCase(c.id, c.stresses, c.expected, c.expected);
  }

  const agent = mastra.getAgent("investigator") as
    | InvestigatorAgent
    | undefined;
  if (!agent) {
    return scoreCase(
      c.id,
      c.stresses,
      c.expected,
      undefined,
      "investigator agent not registered",
    );
  }

  const requestContext = new RequestContext();
  requestContext.set(INVESTIGATION_CTX_KEY, { vendor: bundle.invoice.vendor });

  let got: Recommendation | undefined;
  try {
    const out = await runInvestigation(
      agent,
      match,
      bundle.invoice.vendor,
      requestContext,
    );
    got = out?.investigation.recommendation;
  } catch (err) {
    return scoreCase(
      c.id,
      c.stresses,
      c.expected,
      undefined,
      err instanceof Error ? err.message : "agent call failed",
    );
  }
  return scoreCase(c.id, c.stresses, c.expected, got);
}

// ── reporting ────────────────────────────────────────────────────────────────

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}
function colorPct(n: number): string {
  const s = pct(n).padStart(4);
  if (n >= 0.999) return col(C.green, s);
  if (n >= 0.75) return col(C.yellow, s);
  return col(C.red, s);
}

function printTable(scores: CaseScore[]) {
  console.log(col(C.bold, "\nPer-case results\n"));
  const idW = Math.max(8, ...scores.map((s) => s.id.length));
  console.log(
    col(
      C.gray,
      "  " + "case".padEnd(idW) + "  expected           got                ",
    ),
  );
  console.log(col(C.gray, "  " + "─".repeat(idW + 40)));
  for (const s of scores) {
    const mark = s.failed
      ? col(C.red, "FAIL")
      : s.correct
        ? col(C.green, "✓")
        : col(C.red, "✗");
    const got = s.failed ? col(C.red, s.failed) : (s.got ?? "—");
    console.log(
      "  " +
        s.id.padEnd(idW) +
        "  " +
        s.expected.padEnd(18) +
        " " +
        String(got).padEnd(18) +
        " " +
        mark +
        col(C.dim, `  ${s.stresses}`),
    );
  }
}

function printSummary(scores: CaseScore[]) {
  const conf = overchargeConfusion(scores);
  console.log(col(C.bold, "\nSummary\n"));
  const row = (label: string, value: string) =>
    console.log("  " + label.padEnd(28) + value);
  row("Model", col(C.cyan, PIPELINE_MODEL));
  row("Cases", String(scores.length));
  row("Accuracy", colorPct(accuracy(scores)));
  row(
    "Overcharge precision",
    colorPct(conf.precision) +
      col(
        C.gray,
        `  ${conf.truePositives}tp / ${conf.truePositives + conf.falsePositives}`,
      ),
  );
  row(
    "Overcharge recall",
    colorPct(conf.recall) +
      col(
        C.gray,
        `  ${conf.truePositives}tp / ${conf.truePositives + conf.falseNegatives}`,
      ),
  );
  row("Overcharge F1", colorPct(conf.f1));
  console.log();
}

async function main() {
  loadEnv();

  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const filter = args.filter((a) => !a.startsWith("--"));

  if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      col(C.red, "ANTHROPIC_API_KEY is not set.") +
        " Add it to .env.local (see .env.example), then re-run `pnpm eval`." +
        col(
          C.gray,
          "\n(Tip: `pnpm eval --dry-run` validates the harness without calling the API.)",
        ),
    );
    process.exit(1);
  }

  const cases =
    filter.length === 0
      ? EVAL_CASES
      : EVAL_CASES.filter((c) => filter.includes(c.id));
  if (cases.length === 0) {
    console.error(
      `No matching cases. Known ids: ${EVAL_CASES.map((c) => c.id).join(", ")}`,
    );
    process.exit(1);
  }

  console.log(
    col(C.bold, `\nledgerloop — investigator eval`) +
      col(
        C.gray,
        `  (${cases.length} case${cases.length === 1 ? "" : "s"}, model ${PIPELINE_MODEL})`,
      ) +
      (dryRun
        ? col(C.yellow, "  [dry-run: scoring ground truth, no API calls]")
        : ""),
  );

  const scores: CaseScore[] = [];
  for (const c of cases) {
    process.stdout.write(col(C.gray, `  · ${c.id} … `));
    const t0 = Date.now();
    const score = await runOneCase(c, dryRun);
    const dt = Date.now() - t0;
    scores.push(score);
    process.stdout.write(
      (score.failed
        ? col(C.red, `fail`)
        : score.correct
          ? col(C.green, `ok`)
          : col(C.yellow, `miss`)) + col(C.gray, ` (${dt}ms)\n`),
    );
  }

  printTable(scores);
  printSummary(scores);

  // Gate: hard failures (agent errored / corpus broken) always fail. On a real
  // run we also require the agent to catch every real overcharge — a missed
  // overcharge (recall < 1) is the expensive error, so CI/local should see it.
  const hardFailures = scores.filter((s) => s.failed).length;
  const conf = overchargeConfusion(scores);
  const recallMiss = !dryRun && conf.falseNegatives > 0;
  if (hardFailures > 0) {
    console.error(col(C.red, `✖ ${hardFailures} case(s) hard-failed.`));
  }
  if (recallMiss) {
    console.error(
      col(
        C.red,
        `✖ missed ${conf.falseNegatives} real overcharge(s) (recall < 100%).`,
      ),
    );
  }
  process.exit(hardFailures > 0 || recallMiss ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
