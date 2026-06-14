Build a portfolio/demo project called "ledgerloop" — a multi-agent finance-ops toolkit
that showcases agent orchestration with Mastra. This is a SHOWCASE REPO, not a real
SaaS: the goal is to impress a fintech CTO in 30 seconds and let me discuss it for 20
minutes in a sales call. Optimize for "demonstrates agentic orchestration clearly" over
"production-grade / scalable". Quality over quantity: ONE polished, finished project.

## Context about me (the developer this repo represents)
I'm Dylan Mérigaud, freelance AI Full-Stack Engineer. 9 years full-stack. Ex-Pivot
(procurement fintech in Paris — I shipped the PO approval flow and the NetSuite
integration). Founder of Neige (AI agent platform). I list Mastra on my CV/bio but have
barely used it — this repo is partly to learn it for real and partly to have a credible
public proof. So: write idiomatic, well-structured Mastra code and a README that teaches
me the patterns as it goes. Stack I already know: Next.js, TypeScript, Node, Supabase.

## Visibility
The GitHub repo starts PRIVATE (I build in peace), but I will flip it PUBLIC once it's
clean and finished — it's meant to become a sales asset that prospects click. So write
all code, comments, and the README as if they will be public (no throwaway TODOs left in,
no secrets, a README that sells). The live Vercel demo is public from the start.

## What the product simulates
The procure-to-pay pipeline, run by a chain of cooperating agents:
  invoice intake  ->  2/3-way matching (PO + goods-receipt + invoice)  ->  approval routing  ->  reconciliation
This single pipeline is chosen because it touches the products of many of my prospects
(matching, reconciliation, approval) so the demo link is relevant to all of them.

## Architecture (decided — do not re-litigate these)
- Mastra multi-agent system. At least 4 distinct agents (Intake, Matching, Approval,
  Reconciliation) that pass state between each other. The VALUE of the demo is the
  orchestration + conditional routing (e.g. when matching finds a price/qty mismatch
  above a threshold, route to Approval instead of straight-through). Make the agents
  REAL agents with tools, not a single prompt pretending to be many.
- Reuse an invoice-parser concept as the Intake agent (parse a PDF -> structured line
  items). A simple LLM-based parser is fine; PDFs can be mock/sample files in the repo.
- DB: Supabase Postgres + Drizzle ORM. Minimal schema: invoices, purchase_orders,
  goods_receipts, agent_runs (the execution log — this table is the key visual asset).
- Seed the DB with ~10 realistic invoices + matching POs. INCLUDE deliberate edge cases:
  one price mismatch, one quantity mismatch, one duplicate invoice. These edge cases ARE
  the demo scenario (the agent catching them is what impresses).
- ERP integration is a FAKE adapter (a stub module with a clear interface) — never a real
  NetSuite/ERP call. A comment should note "real NetSuite integration shipped at Pivot".

## Demo UX (this is what sells — get it right)
- NO AUTH. Public, zero friction. Visitor lands directly on the dashboard with data present.
- Split-view dashboard:
  - LEFT: queue of invoices, status color-coded per stage (intake / matched / needs-approval / reconciled).
  - RIGHT: for the selected invoice, the AGENT EXECUTION TRACE as a vertical timeline.
    Show each agent step, including the red "caught a mismatch" step and the conditional
    routing to Approval. This trace is THE thing a CTO must see to believe it's real
    multi-agent orchestration, not a prompt wrapper.
- A "Run pipeline" button on an invoice triggers the agents and STREAMS the trace live.

## Critical: state must NOT pollute across visitors
The seeded data is READ-ONLY in practice. The "Run pipeline" action executes the agents
SERVER-SIDE but does NOT persist results to the DB — it reads the seeded invoice/PO,
runs the agents, streams the trace to that visitor's browser, and forgets. Each "Run" is
a stateless, throwaway computation. No sessions, no per-user memory, no writes. This way
the 50th visitor sees the same pristine seeded state as the 1st. Do not build CRUD that
mutates shared DB state.

## Streaming (decided)
- Mastra exposes a native stream of agent/workflow events — relay it, don't hand-roll events.
- Next.js App Router Route Handler returns a Response wrapping a ReadableStream
  (SSE-style HTTP chunked transport). Use POST (client sends which invoice to run), so the
  client reads via fetch + response.body.getReader() rather than the GET-only EventSource API.
- Use the Edge runtime for the streaming route to avoid serverless timeout on chained agents.
- Use a fast model for the agents (e.g. a small/fast Claude or 4o-mini class) so a full
  4-agent run completes in a few seconds — no timeout, snappy demo.

## Frontend stack
Next.js (App Router) + Tailwind + shadcn/ui. Use prebuilt components — I'm proving
orchestration, not CSS. Clean, minimal, professional dashboard.

## Secrets / safety (the repo will be PUBLIC)
- .env in .gitignore. Provide a .env.example with empty var names (OPENAI_API_KEY=,
  ANTHROPIC_API_KEY=, DATABASE_URL=, etc.). Never commit real keys.
- README must tell a cloner to set keys in Vercel env vars + locally, never in the repo.
- Note in README to set a spend cap on the API key since the demo is public.

## Engineering conventions — INHERIT THESE from my existing invoice-parser repo
I already ship a sibling demo (ai-invoice-parser) with a deliberate, opinionated toolchain.
ledgerloop must match it so the two public repos show one consistent engineering discipline
(a CTO who opens both should see the same standards). These are decided — apply them:

- **Package manager: pnpm**, pinned via the `packageManager` field (e.g. "pnpm@10.x"). Not npm/yarn.
- **NO ESLint, NO Prettier.** This is intentional, not laziness. Replace them with three cheap,
  zero-babysit gates wired as scripts:
  - `pnpm typecheck` -> `tsc --noEmit` under strict mode (catches type errors + dead code within a file)
  - `pnpm knip` -> knip, catches dead code ACROSS the project (unused exports, files, dependencies)
  - `pnpm test` -> Node's built-in test runner via tsx (`tsx --test "**/*.test.ts"`), NO extra test deps
- **tsconfig strict++**: `"strict": true` PLUS `"noUncheckedIndexedAccess": true`,
  `"noUnusedLocals": true`, `"noUnusedParameters": true`. Target ES2022, `moduleResolution: "bundler"`,
  `"@/*"` path alias to root. (Copy the invoice-parser tsconfig shape.)
- **Pin dependency versions exactly** (no `^`/`~` ranges) — reproducible installs, like the sibling repo.
- **Zod as the single source of truth** (this is the repo's signature pattern, transpose it to the
  agent state): define the pipeline/agent I-O schemas in Zod, derive the JSON schema handed to the
  model from them, validate every model/tool output against them at runtime, and let the INFERRED
  TypeScript type flow into the DB layer and the UI. The model and the validator must not be able to
  drift. Validate at every boundary; fail gracefully (never crash the stream on a bad model output —
  surface the error as a trace step instead).
- **CI via GitHub Actions** (`.github/workflows/ci.yml`): on push + PR to main, run
  `pnpm install --frozen-lockfile` then typecheck -> knip -> test -> build, on Node 22 with pnpm cache.
  Mirror the invoice-parser workflow. Do NOT run anything that calls the LLM API in CI (no secret, costs
  tokens) — if there's an eval/sanity script that hits the API, give it a `--dry-run` offline mode and
  run only that in CI.
- **README with status badges** (CI, Next.js 15, TypeScript-strict, the model, "database: Supabase")
  and the same honest framing as the sibling: "a deliberately small, finished, deployable demo — the
  point isn't feature breadth, it's that the production parts (typed boundaries, validation, graceful
  failure, streaming orchestration) are all here and working."
- **Few, focused unit tests** with the Node runner on the PURE logic only (the matching/anomaly rules,
  the schema accept/reject, formatters) — the same functions the agents use, so the tests measure the
  real pipeline, not a reimplementation. No need to test the UI or mock the LLM heavily.

## Deliverables
1. Working Next.js app, deployable to Vercel (front + API routes) with Supabase Postgres.
2. The 4-agent Mastra pipeline with real conditional routing and the agent_runs trace.
3. Drizzle schema + a seed script with the edge-case dataset.
4. The split-view streaming dashboard described above.
5. A SELLING README: what it is, the architecture (a diagram of the agent flow), the
   Mastra patterns used (so it reads as a competent showcase), local setup, deploy steps,
   and the env-var/secrets section. Status badges at the top. Tone: confident, technical, concise.
6. A .env.example.
7. The toolchain from "Engineering conventions" above: pnpm + strict tsconfig + knip +
   Node-runner tests + a GitHub Actions CI workflow. All four scripts (typecheck/knip/test/build)
   must pass clean before you consider the repo done.

## How to work
- Start by proposing a concrete file/folder structure and the agent/tool breakdown, then
  build iteratively. Explain the Mastra-specific patterns as you introduce them (I'm
  learning the framework through this repo).
- Ask me for the Supabase connection string and API keys when you reach the point of
  needing them; until then, scaffold so it runs with env vars.
- Don't over-engineer. No auth, no multi-tenancy, no real ERP, no payment. Keep tests to the
  few pure-logic ones described above. Ship the demo.
- If my invoice-parser repo is available locally (likely at ~/code/invoice-parser-demo), read
  its tsconfig.json, package.json scripts, and .github/workflows/ci.yml and MIRROR their shape
  so the two repos are consistent. Don't copy app code (different domain) — copy the toolchain
  conventions only.

First step: confirm the plan + propose the repo structure and the 4-agent design (agents,
their tools, the state passed between them, and where the conditional routing lives), and the
toolchain setup (pnpm + tsconfig + knip + Node-runner tests + CI). Then start scaffolding.
