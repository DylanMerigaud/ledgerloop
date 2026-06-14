# ledgerloop

Multi-agent finance-ops toolkit for the procure-to-pay loop, built with [Mastra](https://mastra.ai).

A chain of cooperating agents runs the cycle:

```
invoice intake  →  2/3-way matching  →  approval routing  →  reconciliation
```

Each invoice flows through real agents that pass state between each other, with conditional
routing (a price or quantity mismatch routes to approval instead of straight-through). The
dashboard streams the live agent execution trace so you can watch the orchestration happen.

> Status: scaffolding in progress. See `PROMPT.md` for the full build spec.

## Stack
- Mastra (agent orchestration)
- Next.js (App Router) + Tailwind + shadcn/ui
- Supabase Postgres + Drizzle ORM
- Deployed on Vercel

---

Built by [Dylan Mérigaud](https://www.linkedin.com/in/dylanmerigaud) — freelance AI full-stack engineer, ex-Pivot (procurement fintech).
