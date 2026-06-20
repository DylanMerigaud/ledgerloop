import { Dashboard } from "@/components/dashboard";
import { SocialLinks } from "@/components/social-links";
import { listInvoiceQueue, type QueueItem } from "@/db/client";
import { PIPELINE_MODEL } from "@/src/mastra/model";

/**
 * The dashboard page (server component).
 *
 * Reads the seeded invoice queue from Postgres on the server and hands it to the
 * client Dashboard. No auth, zero friction — a visitor lands straight here with
 * data present. If the database isn't configured yet (no DATABASE_URL), we render
 * a clear setup notice instead of crashing, so the app still builds and runs.
 *
 * `force-dynamic` because the queue is read per request (and to keep the demo
 * honest — there's a live DB behind it), though the data is static seed data.
 */
export const dynamic = "force-dynamic";

export default async function Page() {
  let queue: QueueItem[] = [];
  let dbError: string | null = null;
  try {
    queue = await listInvoiceQueue();
  } catch (err) {
    dbError =
      err instanceof Error && err.message.includes("DATABASE_URL")
        ? "DATABASE_URL is not set."
        : "Could not reach the database.";
  }

  return (
    // On desktop the page is exactly viewport-tall (flex column) so there is ONE
    // scroll context — inside the queue/trace panels — not a competing page
    // scroll. On mobile it falls back to natural height + normal page scroll.
    <main className="mx-auto flex max-w-[1200px] flex-col px-4 pb-3 pt-6 sm:px-6 sm:pt-8 lg:h-screen lg:pb-4">
      <Header />
      <div className="min-h-0 flex-1">
        {dbError ? (
          <SetupNotice detail={dbError} />
        ) : queue.length === 0 ? (
          <SetupNotice detail="The database is reachable but empty — run `pnpm db:seed` to load the demo invoices." />
        ) : (
          <Dashboard queue={queue} />
        )}
      </div>
      <Footer />
    </main>
  );
}

function Header() {
  return (
    <header className="mb-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">
            ledgerloop
          </h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-muted">
            A chain of AI agents runs each invoice through{" "}
            <span className="text-ink">procure-to-pay</span> — with the live
            execution trace and a real human approval gate on caught mismatches.
          </p>
        </div>
        <div className="flex items-center gap-1.5 text-[11px] text-muted">
          <FlowChip n={1} label="Intake" />
          <Arrow />
          <FlowChip n={2} label="Matching" />
          <Arrow />
          <FlowChip n={3} label="Approval" />
          <Arrow />
          <FlowChip n={4} label="Reconcile" />
        </div>
      </div>
    </header>
  );
}

function FlowChip({ n, label }: { n: number; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface px-2.5 py-1 ring-1 ring-inset ring-line">
      <span className="flex h-4 w-4 items-center justify-center rounded-full bg-accent-soft text-[9px] font-semibold text-accent">
        {n}
      </span>
      {label}
    </span>
  );
}

function Arrow() {
  return (
    <span aria-hidden className="text-line">
      →
    </span>
  );
}

function SetupNotice({ detail }: { detail: string }) {
  return (
    <div className="rounded-xl border border-warn-line bg-warn-soft/50 px-5 py-4 text-[13px] text-ink">
      <p className="font-medium">Almost there — the demo needs its database.</p>
      <p className="mt-1 text-ink/80">{detail}</p>
      <p className="mt-2 text-ink/70">
        Set{" "}
        <code className="rounded bg-surface px-1 py-0.5 font-mono text-[12px]">
          DATABASE_URL
        </code>{" "}
        (and{" "}
        <code className="rounded bg-surface px-1 py-0.5 font-mono text-[12px]">
          ANTHROPIC_API_KEY
        </code>
        ) in your environment, then run{" "}
        <code className="rounded bg-surface px-1 py-0.5 font-mono text-[12px]">
          pnpm db:push && pnpm db:seed
        </code>
        . See the README for the full setup.
      </p>
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-[12px] text-muted">
      <p>
        Built with <span className="text-ink">Mastra</span> · agents on{" "}
        <span className="font-mono text-ink">{PIPELINE_MODEL}</span> · Next.js ·
        Supabase · Drizzle. Runs are stateless — nothing is written back.
      </p>
      <div className="flex items-center gap-2">
        <span className="text-ink">Dylan Mérigaud</span>
        <SocialLinks />
      </div>
    </footer>
  );
}
