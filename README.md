# ledgerloop

Four cooperating AI agents run an invoice through the **procure-to-pay** loop — intake → 2/3-way matching → approval routing → reconciliation — and the dashboard **streams the agent execution trace live** as it happens, including the moment a price/quantity mismatch is caught and the run is conditionally routed to human approval. Built with [Mastra](https://mastra.ai).

### ▶︎ [Try the live demo →](https://ledgerloop.vercel.app/)

> A deliberately small, finished, deployable demo. The point isn't feature breadth — it's that the production parts (typed agent boundaries, runtime validation, conditional orchestration, graceful failure, live streaming) are all here and working, which is what separates a multi-agent *system* from a prompt in a loop.

[![CI](https://github.com/DylanMerigaud/ledgerloop/actions/workflows/ci.yml/badge.svg)](https://github.com/DylanMerigaud/ledgerloop/actions/workflows/ci.yml) ![Mastra](https://img.shields.io/badge/agents-Mastra-000000) ![Next.js](https://img.shields.io/badge/Next.js-15-black) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6) ![model](https://img.shields.io/badge/Claude-Haiku_4.5-4F46E5) ![database](https://img.shields.io/badge/database-Supabase-3ECF8E)

---

## What it does

The demo simulates the **accounts-payable pipeline** an AP team runs on every vendor invoice:

```
        ┌──────────┐     ┌───────────┐     ┌────────────┐     ┌─────────────────┐
  PDF → │  Intake  │ →   │  Matching │ →   │  Approval  │ →   │ Reconciliation  │ → ERP
        │  agent   │     │   agent   │     │   agent    │     │     agent       │
        └──────────┘     └─────┬─────┘     └────────────┘     └─────────────────┘
                               │                  ▲
                               │   clean match    │  price / qty / duplicate
                               └──────────────────┴── exception → route to a human
                                  straight-through
```

1. **Intake** confirms and structures the invoice (the PDF-parsing role — the same job as the sibling [ai-invoice-parser](https://github.com/DylanMerigaud) repo).
2. **Matching** runs a **2-way** (invoice ↔ PO) or **3-way** (invoice ↔ PO ↔ goods receipt) match and returns a verdict: `clean`, `exception`, or `duplicate`.
3. **Conditional routing** — *this is the demo*. A clean match goes **straight through** to reconciliation. An exception (a price variance, a quantity overbill, an off-PO line) is **routed to the Approval agent**, which tiers it to manager or director by the money and variance at stake. A duplicate is **blocked** so it's never paid twice.
4. **Reconciliation** posts the vendor bill + its double-entry GL distribution to the ERP (a fake adapter — see below) and returns the reference.

The split-view dashboard shows the **invoice queue** on the left (color-coded by outcome) and, on the right, the **live agent execution trace** for the selected invoice — each agent step, each tool call, the red "caught a mismatch" step, and the branch to approval — streamed in as the agents run.

### The seeded scenario

The database is seeded with ~10 realistic invoices, **including three deliberate edge cases** — these are the demo:

| Invoice | Scenario | What the agents do |
| --- | --- | --- |
| `INV-2042` | **Price mismatch** — steel bar invoiced ~9% over the PO price | Matching flags `price_variance` → routed to **approval** |
| `INV-2048` | **Quantity mismatch** — invoiced 100 units, only 80 received | The **3-way** receipt check flags it → **director** approval |
| `INV-2041` (re-send) | **Duplicate** — the same invoice number arrives twice | Matching returns `duplicate` → **blocked**, not posted |
| 6 × clean | Clean 2-way / 3-way matches | Auto-approved → **straight-through** to reconciliation |

---

## How it's built — the Mastra patterns

This repo is also a from-scratch tour of building a real multi-agent system with Mastra. The patterns worth calling out:

### 1. A workflow of agent steps with conditional branching

The pipeline is a **Mastra workflow** ([`src/mastra/workflows/p2p.ts`](src/mastra/workflows/p2p.ts)) composed of typed steps:

```ts
createWorkflow({ id: "p2p", inputSchema: RunInput, outputSchema: ReconResult })
  .then(intakeStep)
  .then(matchingStep)
  .branch([
    // anything that isn't a clean straight-through match goes to Approval
    [async ({ inputData }) => inputData.verdict !== "clean", approvalStep],
    // clean matches auto-approve and skip the human step
    [async ({ inputData }) => inputData.verdict === "clean", autoApproveStep],
  ])
  .map(/* normalise the branch output back to one shape */)
  .then(reconciliationStep)
  .commit();
```

`.branch([[condition, step], …])` is Mastra's conditional routing: the first matching condition's step runs, and its output is keyed by that step's id. That single `.branch(...)` is the orchestration the whole demo exists to show.

### 2. Four real agents, each with tools

Each stage is a real [`Agent`](src/mastra/agents) (`@mastra/core/agent`) with focused instructions and its own tools — not one prompt pretending to be many. Agents are looked up by id from the central [`Mastra`](src/mastra/index.ts) registry inside the workflow steps (`mastra.getAgent("matching")`).

The model is set in one place ([`src/mastra/model.ts`](src/mastra/model.ts)) via Mastra's **built-in model router** — a string like `"anthropic/claude-haiku-4-5"` resolves the provider with no SDK wiring, reading `ANTHROPIC_API_KEY` from the environment. A small/fast Claude keeps a full four-agent run to a few seconds.

### 3. Agents call tools, deterministic rules decide

The matching/approval/reconciliation **decisions** are **pure, unit-tested functions** ([`lib/matching.ts`](lib/matching.ts), [`lib/policy.ts`](lib/policy.ts), [`lib/erp.ts`](lib/erp.ts)), exposed to each agent as a [tool](src/mastra/tools). At each stage the agent is invoked, **calls its tool** (a real `tool-call` you can watch in the trace), and narrates the result. The tool doesn't trust the model to pass the documents — the workflow step injects the trusted, server-side bundle into the agent's `requestContext` ([`tools/context.ts`](src/mastra/tools/context.ts)), and the tool reads it from there and runs the pure function on it.

The deliberate twist that keeps this **reliable enough to demo live**: the step also computes that same pure function directly and treats *that* as the authoritative result for routing ([`workflows/run-agent-step.ts`](src/mastra/workflows/run-agent-step.ts)). So the agent genuinely invokes its tool and writes the prose, but the verdict that drives the `.branch(...)` never depends on parsing a model response. If the model is slow, declines to call the tool, or the call fails entirely (no key, rate limit), the deterministic result and a fallback narration still stand — a flaky model degrades the prose, it never changes the routing or breaks the pipeline. Agents narrate and invoke; rules decide.

### 4. Zod as the single source of truth

Every pipeline shape is defined once in Zod ([`lib/schema.ts`](lib/schema.ts)) and:

- constrains the intake model (the invoice schema is compiled to the JSON schema handed to the model),
- validates **every** boundary at runtime — model output, tool output, and database rows are all `safeParse`d, so a bad value becomes a handled trace step, never a crash,
- and its **inferred TypeScript types** flow into the Drizzle schema, the workflow step I/O, the streaming trace, and the React UI.

The model, the validator, the database, and the screen can't drift — they're one definition. (This is the signature pattern carried over from the sibling repo, transposed from one extraction step to a four-stage pipeline.)

### 5. Native streaming, relayed and adapted

Mastra emits a native event stream for a workflow run. The [run route](app/api/run/route.ts) calls `run.stream()` and relays `result.fullStream` (a `ReadableStream` of typed chunks) to the browser as newline-delimited JSON. A small **adapter** ([`lib/trace.ts`](lib/trace.ts)) maps each raw Mastra chunk to a stable, UI-facing `TraceEvent` — so the dashboard depends on *our* vocabulary, not Mastra's internal chunk format, and an unrecognized chunk is dropped rather than crashing the stream. The client reads it with `fetch` + `response.body.getReader()`.

---

## Architecture

```
Browser (Next.js App Router)
  ├─ page.tsx  ── server-reads the invoice queue from Postgres
  └─ Dashboard (client) ── split view: queue ▸ live trace timeline
        │  POST /api/run { id }
        ▼  reads the NDJSON stream via fetch + getReader()
app/api/run/route.ts  (Node runtime, streaming Response)
  1. validate body (Zod)                       → 400
  2. loadRunBundle(id) from Postgres (READ-ONLY, Zod-validated)  → 404 / 500
  3. mastra.getWorkflow("p2p").createRun().stream({ inputData })
  4. relay result.fullStream, adapting each chunk → TraceEvent (NDJSON line)
     · errors surface as a red trace event, never tear down the stream
     · NOTHING is written back — the run is stateless (see below)

src/mastra/
  index.ts                  the Mastra registry (4 agents + the workflow)
  model.ts                  one model id for the whole pipeline (router string)
  agents/                   intake · matching · approval · reconciliation
  tools/                    tools that read input from requestContext + run the pure logic
  tools/context.ts          the typed requestContext keys the steps inject
  workflows/p2p.ts          the chain + .branch() conditional routing
  workflows/run-agent-step  invoke agent → fire tool + narrate; rules stay authoritative
  testing/                  mock model + offline integration tests for the agent wiring
lib/
  schema.ts           Zod single source of truth → types + JSON schema
  matching.ts         pure 2/3-way matcher + variance      (unit-tested)
  policy.ts           pure approval-routing policy          (unit-tested)
  erp.ts              fake ERP adapter (typed swap-point)   (unit-tested)
  trace.ts            Mastra chunk → TraceEvent adapter     (unit-tested)
  ndjson.ts           the stream framing both ends share    (unit-tested)
db/
  schema.ts           Drizzle: invoices, purchase_orders, goods_receipts, agent_runs
  seed-data.ts        the edge-case dataset                 (verdicts unit-tested)
  seed.ts             pnpm db:seed
  client.ts           read-only, Zod-validated query layer
```

### Two design choices worth a sentence each

- **Stateless by design — state never pollutes across visitors.** The seeded data is read-only. "Run pipeline" executes the agents **server-side** and streams the trace to that visitor's browser, then **forgets** — it writes nothing, not even to `agent_runs`. So the 50th visitor sees the same pristine seeded state as the 1st. The `agent_runs` table is modelled (it's the canonical persisted shape of a run, and the spec's "execution log") but intentionally left empty; the live trace is rendered from the stream, not the database.
- **Node runtime, not Edge.** The build spec suggested the Edge runtime to dodge serverless timeouts on chained agents, but the Postgres driver needs raw TCP sockets the Edge runtime doesn't provide. Vercel's Node functions support HTTP response streaming **and** a configurable `maxDuration`, which meets the real goal — a long-enough, non-timing-out stream — while keeping the DB driver working. A four-agent Haiku run is a few seconds, well inside the limit.

### The fake ERP adapter

[`lib/erp.ts`](lib/erp.ts) is a **stub with a real interface** — never a live ERP call. The reconciliation agent posts through an `ErpAdapter`; swap the `fakeErp` implementation for a `NetSuiteAdapter` of the same interface and the agent is unchanged. (For the record: I shipped the real NetSuite integration — the SuiteTalk vendor-bill + PO-match sync — at Pivot. This stub stands in for it so the public demo stays self-contained and side-effect-free.)

---

## Engineering conventions

No ESLint, no Prettier — three cheap, zero-babysit gates instead, all run in [CI](.github/workflows/ci.yml) on every push/PR:

- `pnpm typecheck` → `tsc --noEmit` under **strict** mode plus `noUncheckedIndexedAccess` / `noUnusedLocals` / `noUnusedParameters` (catches type errors **and** dead code within a file).
- `pnpm knip` → catches dead code **across** the project (unused exports, files, dependencies).
- `pnpm test` → **Node's built-in test runner** via `tsx` — no extra test deps. The tests cover the **pure logic the agents actually use** (the matcher, the approval policy, the trace adapter, the stream framing, the schema accept/reject), an assertion that **every seeded edge case routes to its intended verdict**, and an **offline integration test that runs the real workflow against a mock model** — proving the agent→tool wiring (requestContext reaches the tool, the agent invokes it, the tool call reaches the trace) with no API key, so CI guards it for free.
- `pnpm build` → the Next.js production build.

`pnpm sanity --dry-run` runs the whole deterministic pipeline (match → route → reconcile) over every seeded invoice with **no API calls** — that's what CI runs instead of the live agents (which cost tokens and need a secret). Dependencies are pinned to exact versions for reproducible installs. Package manager is **pnpm** (pinned via `packageManager`).

---

## Getting started

### Prerequisites

- Node 20+ and `pnpm`
- An Anthropic API key — [console.anthropic.com](https://console.anthropic.com)
- A Postgres database — [Supabase](https://supabase.com) (free tier is plenty)

### Setup

```bash
pnpm install
cp .env.example .env.local        # then fill in the two values below
pnpm db:push                      # create the tables in your database
pnpm db:seed                      # load the ~10 invoices + the edge cases
pnpm dev                          # http://localhost:3000
```

Environment variables (see [`.env.example`](.env.example)):

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | **yes** | The four agents (Claude Haiku via Mastra's model router) |
| `DATABASE_URL` | **yes** | Supabase Postgres — use the **transaction pooler** string for the app |
| `DIRECT_DATABASE_URL` | optional | A direct (non-pooled) string for `db:push` / `db:seed`; falls back to `DATABASE_URL` |

> **Set a spend cap on the Anthropic key.** The deployed demo is public and the "Run pipeline" button calls the model. A run is only a handful of short Haiku calls, but a public endpoint deserves a cap (Anthropic console → Limits). Keys live in your environment / Vercel project settings — **never** in the repo.

### Deploy to Vercel

1. Push the repo and import it in Vercel.
2. Set `ANTHROPIC_API_KEY` and `DATABASE_URL` in the project's environment variables.
3. Run `pnpm db:push && pnpm db:seed` once against your database (locally, pointed at the same `DATABASE_URL`) to create + seed the tables.

The `/api/run` route runs on the Node runtime (it reads from Postgres and calls Mastra), with `maxDuration = 60`. That's it — the demo is otherwise stateless.

---

## Notes & trade-offs

- **Why deterministic decisions inside real, tool-calling agents?** A demo whose verdicts depend on the model's mood is a demo that fails on stage. The agents really do invoke their tools (the trace shows it), but the routing is anchored to the tested pure functions those tools run — reliable to demo, honest to test. The natural next step toward a fully-autonomous system is to drop the deterministic anchor and let the model's tool call be the verdict, with the pure function demoted to a grader/guardrail.
- **The seed data is synthetic** and shaped so the matcher produces a clean, explainable verdict for each invoice. The schema + read layer accept real (anonymized) invoices/POs just as well — that's the path to making the numbers reflect production traffic.
- **What I'd add next:** persisted runs behind auth (the `agent_runs` table is already shaped for it), a confidence/why trail per matched line, batch processing of a whole invoice queue, and a real ERP adapter behind the existing interface.

---

## Contact

I build production-grade AI features fast — freelance / contract, fintech & AI. If this is the kind of thing you'd want shipped, let's talk.

- **Live demo** — <https://ledgerloop.vercel.app/>
- **GitHub** — [@DylanMerigaud](https://github.com/DylanMerigaud)
- **LinkedIn** — [in/dylanmerigaud](https://www.linkedin.com/in/dylanmerigaud/)
- **Email** — [dylanmerigaud.pro@gmail.com](mailto:dylanmerigaud.pro@gmail.com)

---

## License

[MIT](LICENSE) — use it however you like.
