/**
 * Edit-AGENT eval — `tsx eval/edit-agent-run.ts [--dry-run]`.
 *
 * Proves the multi-instruction agent end to end: it plans an ordered op list,
 * applies it, self-corrects against the validator, and the FINAL workflow validates
 * clean. Scores the outcome (sound result + enough ops for a multi-part ask), not
 * the individual op kinds (that's the single-op edit eval's job).
 *
 * `--dry-run` (CI) drives `runEditAgent` with a fake planner returning each case's
 * stub ops — exercises the apply+validate loop with ZERO API calls. Live (no flag)
 * uses the real Sonnet planner; needs ANTHROPIC_API_KEY.
 */
import { join } from "node:path";

import {
  AGENT_CASES,
  EDIT_FIXTURE,
  type AgentCase,
} from "@/eval/edit-agent-cases";
import {
  runEditAgent,
  type PlanModel,
  type AgentEditResult,
} from "@/lib/workflow-edit-agent";
import { validateWorkflow, isActivatable } from "@/lib/workflow-validate";

const dryRun = process.argv.includes("--dry-run");

/** The departments the agent may scope a gate to (the demo org's set). A live case
    naming one outside this list should make the planner clarify, not invent. */
const EVAL_DEPARTMENTS = ["Finance", "Operations", "Product", "Sales"];

const loadEnv = (): void => {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(join(process.cwd(), f));
    } catch {
      /* absent — fine */
    }
  }
};

/** A fake planner that returns the case's stub once, then nothing (loop ends). */
const stubModel = (c: AgentCase): PlanModel => {
  let called = false;
  return {
    planOps: () => {
      if (called) return Promise.resolve([]);
      called = true;
      return Promise.resolve(c.stub);
    },
  };
};

type Row = { id: string; pass: boolean; detail: string };

const score = (c: AgentCase, r: AgentEditResult): Row => {
  const realOps = r.ops.filter((o) => o.op !== "none").length;
  const sound = isActivatable(r.issues);
  const enoughOps = realOps >= c.minOps;
  const pass = sound && enoughOps;
  return {
    id: c.id,
    pass,
    detail: `${realOps} op(s), ${sound ? "sound" : `${r.issues.filter((i) => i.severity === "error").length} error(s)`}`,
  };
};

const main = async (): Promise<void> => {
  loadEnv();
  console.log(`edit-agent eval — ${dryRun ? "dry-run (no API)" : "live"}\n`);

  if (!dryRun && !process.env.ANTHROPIC_API_KEY) {
    console.error(
      "✖ Live mode needs ANTHROPIC_API_KEY. Use --dry-run offline.",
    );
    process.exit(1);
  }

  // The real planner loads lib/env; import it only for a live run.
  let liveModel: PlanModel | null = null;
  if (!dryRun) {
    const mod = await import("@/lib/workflow-edit-model");
    liveModel = mod.anthropicPlanModel;
  }

  // The fixture is sound to start (sanity) so any final error is the agent's doing.
  if (!isActivatable(validateWorkflow(EDIT_FIXTURE))) {
    console.error("✖ The eval fixture itself isn't sound — fix the fixture.");
    process.exit(1);
  }

  const rows: Row[] = [];
  for (const c of AGENT_CASES) {
    const model = dryRun ? stubModel(c) : (liveModel ?? stubModel(c));
    const result = await runEditAgent(model, EDIT_FIXTURE, c.instruction, {
      departments: EVAL_DEPARTMENTS,
      vendors: [],
      currencies: [],
    });
    const row = score(c, result);
    rows.push(row);
    console.log(
      `${row.pass ? "✓" : "✗"} ${row.id} — ${row.detail}  (${c.why})`,
    );
  }

  const passed = rows.filter((r) => r.pass).length;
  console.log(`\n${passed}/${rows.length} sound`);
  if (passed !== rows.length) process.exit(1);
  console.log("✓ Every instruction produced a sound workflow.");
};

void main();
