# Agent brief — read this first

You're working on **ledgerloop**, a procure-to-pay demo built as a job/freelance
asset for Didero (procurement-AI). Two surfaces: an **onboarding agent** that reads a
client's HRIS and derives an approval workflow, and a **pipeline** that runs invoices
through that workflow. This file is the context a fresh session needs so it doesn't
re-derive or break conventions. (`.product/*.md` has deeper strategy notes but is
gitignored, so it may be absent in a worktree — this committed brief is the source.)

## Current state (the two surfaces are LINKED — done, don't re-derive)

The "complete loop" is built and on `main`. Key facts a fresh session must know:

- **The derived workflow drives the run.** `AppView` holds the active `ApprovalWorkflow`
  in client state; onboarding pushes it up (discovery + each approved edit), the
  Dashboard reads it and `usePipelineRun` sends it in the oRPC `run` body. Absent (cold
  visit) → the default DAG from `lib/client-profile.ts` (`workflowFromPolicy`) stands in.
  Both tabs stay MOUNTED (hidden, not unmounted) so state survives a tab switch.
- **Manager gate is amount-conditional**, not `always`: fires on any exception OR a clean
  bill over the manager floor ($1,000). Aligned in BOTH `lib/onboarding.ts` (derived) and
  `workflowFromPolicy` (default). So small clean → straight-through, material/flagged →
  human.
- **Department lives on the PurchaseOrder**, carried through `MatchResult` into the engine
  (`lib/approval-run.ts` reads `match.department`). The derived "department review" gate is
  a parallel ROOT scoped to `department == "Product"`; PO-7744 (INV-2044) is the seeded
  Product PO. A pulled (QBO) PO has dept ""; `loadRunBundle` overlays the seeded dept.
- **Multi-wave HITL**: `usePipelineRun` accumulates decisions and the resume sends their
  UNION (the stateless run rebuilds the DAG), and it re-detects `awaiting` on a resume, so
  a gate behind another gate re-pauses instead of posting.
- **Live workflow graph** in the Dashboard: the same `WorkflowGraph` onboarding draws,
  lit by the run's per-step statuses (`readRunGraph` pulls `approval.workflow` + steps from
  the trace), shown between the document scan and the text timeline.
- **e2e** (`pnpm e2e`, local-only, needs keys): `approval.e2e.ts` (HITL on the default) +
  `onboarding-to-pipeline.e2e.ts` (the flagship loop: discover → dept gate → post).

## Hard conventions (non-negotiable — the user is strict about these)

- **No `as` casts.** ESLint `@typescript-eslint/no-unsafe-type-assertion` is ON.
  Narrow with a type guard (`isRecord` in `lib/assert.ts`), validate with a Zod
  schema, or use `satisfies`. `as const` is fine. Genuine boundary casts get a
  per-line `eslint-disable` WITH a reason (rare).
- **No non-null `!`.** Use `nonNull(x, "why")` from `lib/assert.ts`.
- **No `any`.** Rule is ON.
- **Exhaustive switches** end in `assertUnreachable(x)` from `lib/assert.ts`.
- **No `eslint-disable` cop-outs.** Fix at the cause. A disable needs a documented
  reason and is a last resort.
- **The API is oRPC.** Typed procedures in `lib/orpc/router.ts`, shared i/o schemas
  in `lib/orpc/schemas.ts`, browser client + TanStack Query in `lib/orpc/client.ts`,
  one handler at `app/rpc/[[...rest]]/route.ts`. Add a procedure there, not a new
  `app/api/*` route. (The only plain REST route left is `/api/pdf` — binary.)
- **"AI at the edge, deterministic core."** LLM calls do fuzzy intent (structured
  output); deterministic code does structure. The chat-edit is a hand-written
  bounded loop (`lib/workflow-edit-agent.ts`) over the Claude SDK — NOT a Mastra
  Agent (see its header comment for why). Mastra owns the P2P pipeline
  (`src/mastra/workflows/p2p.ts`) and the exception-investigator agent.
- **Stateless by design.** The run never writes to the DB. Keep it that way unless
  told otherwise.
- **The recorded HRIS fixture is SEED-BUILT**, not a live capture
  (`scripts/build-recorded-fixture.ts` → `pnpm fixture:build`). recorded == live ==
  the 13-person "LedgerLoop Demo" org. Don't reintroduce a real-capture claim.
- **Writing style** (comments/commits/PRs): plain, direct, no em-dashes, no
  AI-isms. Match the existing code's comment density and idiom.
- **Do NOT touch the GitHub profile repo.** Repo README is fine to edit.

## Verify before every commit (all must pass)

```
pnpm typecheck && pnpm lint && pnpm knip && pnpm test && pnpm format:check && pnpm build
```

- `pnpm test` = node:test, all faked (free, no API).
- Evals: `pnpm eval:edit --dry-run` and `pnpm eval:edit-agent --dry-run` are free
  (stubs). Live evals cost Anthropic tokens — only run a live eval to PROVE a model
  change works, never casually. The user's rule: don't waste tokens.
- Screenshots: the dev server hits live BambooHR if the key is set (~12s). For fast,
  deterministic screenshots run dev with `BAMBOO_HR_API_KEY= BAMBOO_HR_SUBDOMAIN=`
  so it uses the recorded fixture.

## Git workflow

- Work on your branch (this worktree is already on it). Commit when the user asks or
  when a verified unit of work is done; end commit messages with the
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.
- Don't merge to main yourself unless asked. The user reviews.
- Throwaway scripts/sandbox pages: put them in-repo only while iterating, DELETE
  before committing (they trip the type-aware linter and knip).

## Where things are

- `lib/approval-workflow.ts` — the workflow DAG model, conditions, `humanizeCondition`,
  `diffWorkflows`.
- `lib/approval-engine.ts` — executes the DAG (AND-join, skipped = pass-through).
- `lib/workflow-validate.ts` — structural + AP-best-practice checks (the validator).
- `lib/workflow-edit.ts` / `-agent.ts` / `-model.ts` — the chat-edit ops, the
  bounded agent loop, the Claude planner.
- `lib/onboarding.ts` / `-model.ts` — derive the workflow from an org.
- `lib/hris.ts` — BambooHR adapter (live + recorded) + the mapper.
- `lib/erp.ts` — two seams: the reconciliation POST stub (fake-netsuite) AND the
  PO PULL (QuickBooks live + recorded fixture, same shape as HRIS). `defaultErp()`
  picks live/recorded by env; `loadRunBundle` matches invoices against pulled POs.
- `src/mastra/` — the P2P pipeline + investigator agent + run-stream generator.
- `components/` — onboarding, workflow-editor, workflow-graph (React Flow),
  dashboard, trace-timeline.

## Your task

Ask the user — the link-workflow / department / live-graph work (see "Current state"
above) is done and merged. There may be a `TASK.md` in this folder from a past branch;
treat it as scaffolding, not a live instruction, unless the user points you at it.
