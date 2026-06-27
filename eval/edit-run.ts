/**
 * Conversational-edit eval — `tsx eval/edit-run.ts [--dry-run]`.
 *
 * Runs the REAL edit model over a corpus of plain-language instructions and scores
 * whether it picks the right `WorkflowEditOp` (kind + the params that matter). It's
 * the edit counterpart to the investigator eval: that proves the agent's judgement
 * on exceptions; this proves the agent maps instructions to the correct structured
 * edit — including correctly DECLINING (`none`) when an instruction is redundant or
 * off-topic, the false-positive the old hardcoded suggestions had.
 *
 * `--dry-run` (CI) stubs the model with each case's expected op, so the corpus +
 * scoring run with zero API calls — a perfect score is the expected output. Live
 * (no flag) calls the real Sonnet edit model; needs ANTHROPIC_API_KEY.
 */
import { join } from "node:path";

import { EDIT_CASES, EDIT_FIXTURE, type EditCase } from "@/eval/edit-cases";
import type { WorkflowEditOp } from "@/lib/workflow-edit";
// NOTE: the model (which imports lib/env, validating DATABASE_URL at load) is
// imported DYNAMICALLY after loadEnv() and only when not dry-run — so a dry-run
// has no env dependency at all.

const dryRun = process.argv.includes("--dry-run");

const loadEnv = (): void => {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(join(process.cwd(), f));
    } catch {
      /* absent — fine */
    }
  }
};

type Result = { id: string; pass: boolean; got: string; why: string };

const scoreOne = (c: EditCase, op: WorkflowEditOp): Result => {
  const kindOk = op.op === c.expectedOp;
  const paramOk = c.check ? c.check(op) : true;
  const got = op.op === "none" ? `none (${op.reason})` : op.op;
  return { id: c.id, pass: kindOk && paramOk, got, why: c.why };
};

const main = async (): Promise<void> => {
  loadEnv();
  console.log(
    `conversational-edit eval — ${dryRun ? "dry-run (no API)" : "live"}\n`,
  );

  if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      "✖ Live mode needs ANTHROPIC_API_KEY. Use --dry-run offline.",
    );
    process.exit(1);
  }

  // Import the model only for a live run (it loads lib/env, which validates the DB
  // URL) — a dry-run stays env-free.
  const planEdit = dryRun
    ? null
    : (await import("@/lib/workflow-edit-model")).anthropicEditModel.planEdit;

  const results: Result[] = [];
  for (const c of EDIT_CASES) {
    const op =
      dryRun || !planEdit
        ? stubOp(c)
        : await planEdit(EDIT_FIXTURE, c.instruction);
    results.push(scoreOne(c, op));
  }

  const idW = Math.max(8, ...results.map((r) => r.id.length));
  for (const r of results) {
    const mark = r.pass ? "✓" : "✗";
    console.log(
      `  ${mark} ${r.id.padEnd(idW)}  got=${r.got.padEnd(18)} ${r.why}`,
    );
  }

  const passed = results.filter((r) => r.pass).length;
  const total = results.length;
  console.log(
    `\n${passed}/${total} correct (${Math.round((passed / total) * 100)}%)`,
  );

  if (passed < total) {
    console.error(`\n✖ ${total - passed} case(s) failed.`);
    process.exit(1);
  }
  console.log("✓ Every instruction mapped to the correct edit.");
};

/** Dry-run stub: return an op that satisfies the case (exercises scoring, no API). */
const stubOp = (c: EditCase): WorkflowEditOp => {
  switch (c.expectedOp) {
    case "add-approval":
      return {
        op: "add-approval",
        label: "stub",
        approverTitle: c.id.includes("cfo") ? "CFO" : "Approver",
        amountOver: c.id.includes("cfo") ? 50000 : null,
        department: null,
        vendor: null,
        currency: null,
        matchType: null,
        exceptionCode: null,
      };
    case "add-integration":
      return {
        op: "add-integration",
        label: "stub",
        integration: c.id.includes("jira") ? "jira" : "slack",
      };
    case "set-threshold":
      return {
        op: "set-threshold",
        stepId: "director-review",
        amountOver: 20000,
      };
    case "set-approver":
      return {
        op: "set-approver",
        stepId: "it-review",
        approverName: "Sam Patel",
      };
    case "add-approver":
      return {
        op: "add-approver",
        stepId: "director-review",
        approverName: "Jordan Ellis",
      };
    case "remove-approver":
      return {
        op: "remove-approver",
        stepId: "director-review",
        approverName: "Jordan Ellis",
      };
    case "remove-step":
      return { op: "remove-step", stepId: "it-review" };
    case "none":
      return { op: "none", reason: "stub" };
    default:
      // The insert/parallel ops aren't in this eval's corpus yet; fail loudly if a
      // case ever expects one without a stub.
      throw new Error(`no stub for expectedOp "${c.expectedOp}"`);
  }
};

void main();
