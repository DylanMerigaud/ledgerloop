# ledgerloop

A **procure-to-pay** product in two halves. **Onboarding**: connect a client's HRIS and an agent derives their approval workflow — who signs off on what — resolved to real people from the org chart, with the data-quality problems flagged for a human to fix. **Operations**: a vendor PDF comes in, gets extracted, matched, and run through that workflow, with a live execution trace you watch as it happens.

The two halves are one loop: the workflow you derive and edit on the left is **exactly** what routes the invoice on the right. Edit a gate in plain language, switch to the pipeline, run a bill — it pauses on the approvers and conditions you just defined, and the same graph you built lights up as the run walks it.

AI is used in the places it earns its keep, and nowhere else. **Extraction** reads the messy vendor PDF into structured data (vision). **Onboarding discovery** maps an org's titles to approval authority (genuinely fuzzy judgement). **Investigation** judges a flagged exception against unstructured records and recommends. Everything else — matching, the workflow engine, reconciliation — is deterministic code, because a payment decision must be exact and repeatable, never a model's guess. Nothing posts until a human approves. Built with [Mastra](https://mastra.ai).

The differentiator vs the workflow builders (Ramp, Zip, Pivot): you don't draw the approval graph on a canvas by hand. **The agent derives it from the HRIS, and you maintain it in plain language** — "above $25k also require CFO approval" — with a preview you approve or revert.

### ▶︎ [Try the live demo →](https://ledgerloop-eta.vercel.app/)

[![CI](https://github.com/DylanMerigaud/ledgerloop/actions/workflows/ci.yml/badge.svg)](https://github.com/DylanMerigaud/ledgerloop/actions/workflows/ci.yml) ![Mastra](https://img.shields.io/badge/agent-Mastra-000000) ![Next.js](https://img.shields.io/badge/Next.js-15-black) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6) ![models](https://img.shields.io/badge/Claude-Sonnet_4.6_%2B_Haiku_4.5-4F46E5) ![database](https://img.shields.io/badge/database-Supabase-3ECF8E)

![Running a price-mismatch invoice end to end: the PDF is read and extracted, matching flags the variance, the agent investigates it and recommends, and a human approves before it posts to the ERP](docs/demo.gif)

---

## Onboarding — the agent derives the approval workflow

The forward-deployed-engineer step, made self-serve. Click **Discover from BambooHR** and:

1. The HRIS adapter reads the client's org (one `POST /reports/custom` → the whole roster with ID-based reporting edges).
2. The onboarding agent derives a **conditional approval workflow** — a manager gate, a director gate above an amount threshold, a department review — and **resolves each role to a real person** from the org chart.
3. It **flags the data-quality issues** a human must fix first: a manager who's been terminated, two people who both look like the CEO, junk records with no title. (The seeded org plants these on purpose; the real 91-person BambooHR sample throws up eight of its own.)

The result is a **proposal**: you review the resolved approvers and the flagged issues, then edit the workflow conversationally before it goes live. The agent decides nothing on its own.

**Conversational editing, with preview → approve / revert.** Tell the agent what you want and it proposes a rewrite; the graph shows the diff (added / changed / removed gates) and **nothing is applied until you approve** — the pipeline only ever runs the workflow you've approved.

- The DAG **structure** is a deterministic template; the agent only makes the fuzzy calls (which title fills which approval level → which person, what threshold, plain-language issue notes). Code assembles those into a Zod-validated `ApprovalWorkflow`. An edit that would produce an invalid graph is rejected, never applied.
- `lib/onboarding.ts` (derive + assemble), `lib/onboarding-model.ts` (the structured-output call), `lib/workflow-edit.ts` (conversational edits + diff). The API is one typed **oRPC** contract ([`lib/orpc/`](lib/orpc/)) — `onboarding` and `editWorkflow` are procedures on it, not hand-rolled routes, so a response-shape change is a compile error on both client and server.

---

## Operations — an invoice through the workflow

```mermaid
flowchart LR
    PDF([Vendor PDF]) --> X[Extraction AI<br/>vision → structured]
    X --> M[Matching<br/>deterministic]
    M --> V{Verdict?}

    V -- "clean" --> ENG
    V -- "duplicate" --> BLK[Blocked<br/>never posted]
    V -- "exception" --> INV[Investigator AI<br/>reads messy records,<br/>recommends]

    INV --> ENG[Approval workflow engine<br/>runs the derived DAG]
    ENG --> H{{Human gates<br/>Approve / Reject<br/>per step, in parallel}}
    H -- "all approved" --> POST[Reconciliation → ERP<br/>vendor bill + GL]
    H -- "any rejected" --> REJ[Rejected<br/>not posted]

    classDef ai fill:#EEF2FF,stroke:#4F46E5,color:#0A0A0A;
    classDef gate fill:#FEF3C7,stroke:#B45309,color:#0A0A0A;
    classDef stop fill:#FEE2E2,stroke:#B91C1C,color:#0A0A0A;
    class X,INV ai;
    class H gate;
    class BLK,REJ stop;
```

- **Extraction (AI)** — the vendor's invoice PDF is read by a vision model into a schema-validated `Invoice`. The extracted invoice is what the rest of the pipeline runs on — matching joins the extracted lines against the PO, like production.
- **Matching** — a 2-way (invoice ↔ PO) or 3-way (invoice ↔ PO ↔ goods receipt) match, returning `clean`, `exception`, or `duplicate`. The PO is **pulled from the client's ERP** (QuickBooks Online, [`lib/erp.ts`](lib/erp.ts)) — the procurement mirror of reading their org from BambooHR — so an incoming invoice is matched against their real open POs (read-only; nothing is persisted). The matcher also checks the invoice against the ERP's master data: a vendor the ERP marks **inactive**, a SKU **not in the catalog**, and a bill **already posted** in the ERP (the historical "already paid" duplicate, distinct from a re-send in the queue).
- **Investigation** — runs only on an exception, and the one open-ended agent in the operational path. A number ("9% over the PO") doesn't tell a reviewer whether it's a legitimate price increase or an overcharge; that lives in unstructured records, and which records matter depends on what you find. The agent **chooses** which tools to call, reads them, and recommends. It decides nothing about the money.
- **Approval workflow engine** — the invoice runs through the client's derived DAG ([`lib/approval-engine.ts`](lib/approval-engine.ts)): each gate's condition is evaluated, the active gates **pause for a human** (several can be pending in parallel — a fan-out), and the bill posts only once **every** active gate is approved. One rejection blocks everything downstream. A clean invoice trips no gate and goes straight through.
- **Reconciliation** — posts the vendor bill and double-entry GL to the ERP, only once cleared.

The split-view dashboard shows the **invoice queue** (color-coded by outcome) and the **live execution trace** — each step, the agent's tool calls and recommendation, and the workflow graph coloured by the path this invoice took (approved / pending / skipped / blocked).

### Seeded scenarios

~10 realistic invoices, covering the edge cases and the routing levers:

| Invoice | Scenario | Outcome |
| --- | --- | --- |
| `INV-2042` | Price mismatch — steel bar invoiced ~9% over the PO | `price_variance` → investigator → manager gate → **pauses for your decision** |
| `INV-2048` | Quantity mismatch — invoiced 100 units, only 80 received | 3-way receipt check → manager gate → **pauses for your decision** |
| `INV-2041` (re-send) | Duplicate — same invoice number twice | `duplicate` → **blocked**, not posted |
| `INV-1990` | Already paid — a bill with this number is posted in the ERP | `duplicate_in_erp` → **blocked**, not posted |
| `INV-2050` | Inactive vendor — the ERP marks this supplier inactive | `vendor_inactive` → routed to a human |
| `INV-2044` | Clean, but the PO belongs to **Product** | clean match, yet the **department review** gate fires → pauses for the Product head, in parallel with the manager |
| `INV-2040` | Clean, $730 | under the manager floor → **straight-through**, no human |
| larger clean (e.g. `INV-2049` $9,360) | Clean 2/3-way match over the floor | a human still signs a **material** bill → manager gate |

The manager gate fires on any exception **or** a clean bill over a floor ($1,000), so small clean invoices post straight through while material or flagged ones get a human — the standard AP control, and the same behaviour whether or not you've run discovery (the un-onboarded default reproduces it). The department gate is the differentiator: a buying department lives on the PO, and a workflow can route a department-specific review on it.

---

## How it's built

**AI at the edges, deterministic code in the core.** The ends are language/perception/judgement problems — reading a PDF, mapping titles to approval authority, judging a fuzzy exception — so they use a model. The middle (is this a 9%-over variance? which gates apply? did every gate approve?) is arithmetic and graph logic, so it's pure, unit-tested functions ([`lib/matching.ts`](lib/matching.ts), [`lib/approval-workflow.ts`](lib/approval-workflow.ts), [`lib/approval-engine.ts`](lib/approval-engine.ts), [`lib/erp.ts`](lib/erp.ts)): exact, auditable, identical on every run. An LLM never decides a payment amount.

**The conditional approval workflow.** Approval isn't a single tier — it's a DAG of conditional gates ([`lib/approval-workflow.ts`](lib/approval-workflow.ts)): each step carries a `when` condition (route on amount / variance / department / verdict / vendor / currency / match type / exception code, combinable with all/any) and parallel `next` edges. The conversational editor knows the real values present (the org's departments, the invoices' vendors + currencies), so it only ever builds a gate that can actually fire, and the "What can I change?" doc lists those levers and values — routing is discoverable, not guesswork. The engine ([`lib/approval-engine.ts`](lib/approval-engine.ts)) walks it per invoice with collect-all semantics: a skipped gate is a transparent pass-through, several gates can pend at once, one rejection blocks downstream. **The workflow the onboarding agent derived is what the run executes** — it's passed into the run as input (held in client state, never persisted, so the run stays stateless), and the pipeline routes through it. When no workflow has been derived yet, a default DAG ([`lib/client-profile.ts`](lib/client-profile.ts)) built from simple thresholds stands in, so the pipeline works on a cold visit and behaves the same as a derived one.

**The HRIS adapter is real, captured, replayed.** [`lib/hris.ts`](lib/hris.ts) reads BambooHR (`bambooHris`, live HTTP) or replays a fixture captured from that same API (`recordedHris`); one `defaultHris()` factory picks live-vs-recorded — the only place that branch exists. The committed fixture in [`db/fixtures/bamboohr/`](db/fixtures/bamboohr/) is **real BambooHR output**, captured on a dated run via `pnpm hris:capture` — not a mock — so the demo (and CI, which has no key) runs on real data and survives the trial key expiring. `pnpm hris:seed` / `hris:reset` stand up a curated org in a sandbox (scoped by a dedicated Division, server-side, so reset only removes what it created).

**The ERP adapter is real, captured, replayed — the same seam, on the procurement side.** [`lib/erp.ts`](lib/erp.ts) reads QuickBooks Online (`liveQuickBooksErp`, real OAuth2 + SuiteTalk-style query) or replays a fixture captured from that same API through the **same** mappers (`recordedErp`); one `defaultErp()` factory picks live-vs-recorded, the only place that branch exists. It pulls the client's open **purchase orders** (matched against incoming invoices) plus the master data the AP controls check against — the **vendor** list, the **item catalog**, and the **posted bills**. Everything QuickBooks-specific (the `QueryResponse` wire shape, the token endpoint) stops at this file — swap QBO for a `netSuiteErp` of the same `PoSourceAdapter` and nothing downstream changes. The committed fixture in [`db/fixtures/quickbooks/`](db/fixtures/quickbooks/) is **real QuickBooks output**, captured via `pnpm erp:capture` — not a mock — so the demo and CI run with no key; `pnpm erp:seed` / `erp:reset` stand up the scenario in a sandbox (POs, an inactive vendor, an already-posted bill), scoped so reset only removes what it created. The pull is **read-only**; the run never writes back. The buying **department** is our own overlay (the ERP doesn't carry a vendor-facing cost-centre), so a pulled PO is matched on lines/prices and the department comes from the seed.

**The investigator agent.** [`src/mastra/agents/investigator.ts`](src/mastra/agents/investigator.ts) is a Mastra `Agent` with three tools returning deliberately unstructured records. It runs an open-ended loop — picks which tools to call, reads them, writes a recommendation (`likely_legitimate` / `likely_overcharge` / `unclear`) — and only *recommends*; the engine and the human gate own the outcome. Tools read the trusted vendor from `requestContext`, not model args, so the agent can't pull the wrong vendor's file.

**A real human-in-the-loop, statelessly.** On an exception (or a material clean bill) the run pauses before reconciliation (`awaiting`) and the post doesn't happen until a human approves the pending gate(s). The demo never writes to the database, yet a pause normally needs a persisted run to resume — so instead the Approve/Reject click sends per-step decisions (`{ "director-review": "approve" }`) that recompute the cheap deterministic prefix and continue. The run is the `run` procedure on the oRPC contract, streamed as a typed **event iterator**. Decisions accumulate across waves and the resume sends their union, so a workflow with a gate behind another gate re-pauses on the newly-reached gate instead of silently posting.

**Zod as the single source of truth.** Every shape is defined once in Zod ([`lib/schema.ts`](lib/schema.ts), [`lib/approval-workflow.ts`](lib/approval-workflow.ts)): it constrains the model, validates every boundary at runtime (`safeParse`), and its inferred types flow into Drizzle, the workflow, the stream, and the UI. **Env is typed too** ([`lib/env.ts`](lib/env.ts), `@t3-oss/env-nextjs`): everything reads `env`, never `process.env`.

**Streaming, typed end to end.** The `run` procedure is an **oRPC event iterator** (a typed async generator of `TraceEvent | StreamDone`); the client consumes it with `for await`, no manual reader or cast. A small adapter ([`lib/trace.ts`](lib/trace.ts)) maps Mastra's raw `run.stream()` chunks to the stable `TraceEvent` vocabulary so the UI depends on ours, not Mastra's internals, and a junk chunk is dropped rather than crashing the stream.

### Bounded persistence + a nightly reset

Every run is persisted as an append-only **audit row** ([`agent_runs`](db/schema.ts)) — its verdict, outcome, and the full trace — and the dashboard's **Recent runs** panel lists them, each one replayable (click → the stored trace re-renders with no model call, zero tokens). That's the audit trail an AP buyer asks for first.

The persistence is **bounded**: a daily [Vercel Cron](vercel.json) hits [`/api/reset`](app/api/reset/route.ts) (guarded by `CRON_SECRET`), which truncates + reseeds Postgres — so the demo returns to a pristine queue each morning, the 1st visitor's view restored for the next. The reset touches **Postgres only**; it never calls the QuickBooks/BambooHR sandboxes (frozen fixtures the pipeline reads, never writes), so it can't fail on a rotated token or desync an external system.

Crucially, a saved run **can't change a future run's verdict**: the app writes only `agent_runs`, never the document tables or the ERP/HRIS, so the matcher always reads the pristine seed. Persisting the audit trail and keeping every run deterministic are not in tension. The human-in-the-loop pause/resume stays **replay-based** (the run recomputes the deterministic prefix from the decisions) — persistence is for the audit log, not the resume, which keeps it off the costly Mastra-snapshot path.

### Project layout

```
src/mastra/
  index.ts                 registry (the investigator agent + the workflow)
  agents/investigator.ts   the one operational agent — exception investigation
  tools/                   investigator tools (trusted input from requestContext)
  workflows/p2p.ts         the chain + .branch(); deterministic steps + the agent
lib/
  approval-workflow.ts     the conditional DAG model + condition evaluator + diff
  approval-engine.ts       executes the DAG per invoice (fan-out, collect-all)
  onboarding.ts            derive a workflow from an org (+ onboarding-model.ts)
  workflow-edit.ts         conversational edits + diff (+ workflow-edit-model.ts)
  hris.ts                  BambooHR adapter: live + recorded, one factory
  erp.ts                   QuickBooks adapter: pull POs + master data, live + recorded
  client-profile.ts        per-client config; flat policy → DAG bridge
  matching.ts              pure, unit-tested 2/3-way match + ERP master-data controls
  extract.ts · intake.ts   vision extraction; the intake step that calls it
  orpc/                    the typed API contract (router, schemas, client)
  schema.ts · env.ts       Zod source of truth; typed env
  use-pipeline-run.ts · trace.ts   the run hook (HITL, multi-wave); stream adapter
app/
  rpc/[[...rest]]/         the single oRPC handler (run · onboarding · editWorkflow)
  api/pdf/[id]/            the one plain REST route left (binary PDF)
db/
  schema.ts · seed-data.ts · client.ts   Drizzle + read layer (ERP-pull aware)
  fixtures/bamboohr/ · fixtures/quickbooks/   the real captured HRIS + ERP fixtures
config/eslint-rules/        custom lint rules (no-console, api-routes, …)
```

> **The ERP read path is real; the write-back is a stub** ([`lib/erp.ts`](lib/erp.ts)). The **pull** (purchase orders + vendor/item/bill master data) is a real QuickBooks Online adapter with a captured fixture — see "How it's built". The **reconciliation post** (vendor bill + GL) is still an honest stub behind the same `ErpAdapter` interface: swap `fakeErp` for a real post and the rest is unchanged. Pushing a bill back is the invisible half; importing the client's existing data is the interesting one. The integration steps (Slack/Jira) are likewise honest stubs.

---

## Quality gates

Run in [CI](.github/workflows/ci.yml) on every push/PR:

- `pnpm typecheck` — `tsc --noEmit`, strict + `noUncheckedIndexedAccess` / `noUnusedLocals`
- `pnpm lint` — ESLint (type-aware), aligned with the sibling repo's config: no `any`, no bare `!`, no `as unknown as`, typed env over `process.env`, the logger over `console`, kebab-case files, arrow style, organised imports (see [`eslint.config.mts`](eslint.config.mts))
- `pnpm knip` — dead code across the project (unused exports, files, deps)
- `pnpm test` — Node's built-in runner: the pure decision logic (matching, the workflow engine, the policy→DAG bridge), every seeded edge case, and an offline integration test that runs the real workflow against a **mock model** (the agent→tool→trace wiring, no API key)
- `pnpm build` — Next.js production build
- `pnpm sanity --dry-run` — the full deterministic pipeline over every seeded invoice, no API calls
- `pnpm eval --dry-run` — validates the investigator eval corpus + scoring offline

**Evaluating the agent.** `pnpm eval` ([`eval/`](eval/)) runs the **real investigator** over a labelled corpus and scores its recommendation — accuracy plus precision/recall on catching overcharges. `sanity` proves the deterministic routing; `eval` proves the agent's judgement. It needs a key, so it's local; CI runs `--dry-run`.

`pnpm e2e` is a **Playwright** test driving the real app through the human-in-the-loop flow (run → pause → Approve/Reject). Local-only. Dependencies are pinned exactly; package manager is **pnpm**.

---

## Getting started

```bash
pnpm install
cp .env.example .env.local        # fill in ANTHROPIC_API_KEY + DATABASE_URL
pnpm db:push                      # create the tables
pnpm db:seed                      # load the invoices + edge cases
pnpm dev                          # http://localhost:3000
```

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | **yes** | Extraction (Sonnet vision), the onboarding + edit models (Sonnet), the investigator (Haiku) |
| `DATABASE_URL` | **yes** | Supabase Postgres — use the **transaction pooler** string |
| `DIRECT_DATABASE_URL` | optional | Direct (non-pooled) string for `db:push` / `db:seed` |
| `BAMBOO_HR_API_KEY` + `BAMBOO_HR_SUBDOMAIN` | optional | Live BambooHR. **Without them onboarding replays the committed real fixture** — the demo and CI work with no key. |
| `QBO_CLIENT_ID` + `QBO_CLIENT_SECRET` + `QBO_REFRESH_TOKEN` + `QBO_REALM_ID` | optional | Live QuickBooks (ERP pull). **Without all four the pipeline replays the committed real fixture** — demo and CI work with no key. |
| `UPSTASH_*` / `KV_REST_API_*` | optional | Per-IP rate limiting; fails open without it |
| `CRON_SECRET` | optional | Guards the nightly `/api/reset` cron (Vercel injects it as a bearer token). Unset → the reset route refuses all callers. |

> **Set a spend cap on the Anthropic key** — the deployed demo is public and the buttons call the model.

**Deploy to Vercel:** import the repo, set `ANTHROPIC_API_KEY` + `DATABASE_URL`, run `pnpm db:push && pnpm db:seed` once against the same database. The API routes run on the Node runtime with `maxDuration = 60`.

---

## What's next

The decision logic is pure, typed, and unit-tested; the read-side integrations (HRIS, ERP pull) are already real-or-replayed; and runs are persisted as an audit trail bounded by a nightly reset. Production is additive, not a rewrite:

- the ERP **pull** is real (QuickBooks); swap the **post**-side stub (`fakeErp`) and the Slack/Jira integration stubs for real adapters of the same interfaces,
- live BambooHR + QuickBooks (both adapters + captured fixtures already exist; keys unlock the live path) and a second HRIS / ERP behind the same `HrisAdapter` / `PoSourceAdapter`,
- the audit trail persists today (append-only `agent_runs`, replayable, reset nightly); drop the reset and add per-tenant scoping for a multi-client deployment, and persist the paused-run snapshot if you want resume to survive a server restart (today it's recomputed from the decisions),
- wire real approver identity to the per-step gates,
- accept real uploaded PDFs at intake.

---

## Contact

I build production-grade AI features fast — freelance / contract, fintech & AI.

- **Live demo** — <https://ledgerloop-eta.vercel.app/>
- **GitHub** — [@DylanMerigaud](https://github.com/DylanMerigaud)
- **LinkedIn** — [in/dylanmerigaud](https://www.linkedin.com/in/dylanmerigaud/)
- **Email** — [dylanmerigaud.pro@gmail.com](mailto:dylanmerigaud.pro@gmail.com)

## License

[MIT](LICENSE)
