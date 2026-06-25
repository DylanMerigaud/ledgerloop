import { AppView } from "@/components/app-view";
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
    <main className="mx-auto flex max-w-[1240px] flex-col px-4 pb-3 pt-7 sm:px-8 sm:pt-9 lg:h-screen lg:pb-5">
      <Header />
      <div className="min-h-0 flex-1">
        {dbError ? (
          <SetupNotice detail={dbError} />
        ) : queue.length === 0 ? (
          <SetupNotice detail="The database is reachable but empty — run `pnpm db:seed` to load the demo invoices." />
        ) : (
          <AppView queue={queue} />
        )}
      </div>
      <Footer />
    </main>
  );
}

const Header = () => {
  return (
    <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex items-center gap-3">
        <LogoMark />
        <div>
          <h1 className="text-[19px] font-semibold leading-none tracking-tight text-ink">
            ledgerloop
          </h1>
          <p className="mt-1.5 max-w-xl text-[13.5px] leading-snug text-muted">
            An onboarding agent that reads a client&apos;s HRIS and{" "}
            <span className="font-medium text-ink">
              derives their approval workflow
            </span>
            , then runs procure-to-pay against it.
          </p>
        </div>
      </div>
      <a
        href="https://github.com/DylanMerigaud/ledgerloop"
        target="_blank"
        rel="noreferrer noopener"
        className="hidden shrink-0 items-center gap-1.5 rounded-full bg-subtle px-3 py-1.5 text-[12px] font-medium text-muted ring-1 ring-inset ring-line-strong transition-colors hover:text-ink sm:inline-flex"
      >
        <span className="size-1.5 rounded-full bg-ok" aria-hidden />
        Live demo · source on GitHub
      </a>
    </header>
  );
};

/** Logo mark: an "ll" monogram whose strokes curl into a loop — the ledgerloop
    glyph (matches app/icon.svg). The second stroke is the accent. */
const LogoMark = () => {
  return (
    <div
      aria-hidden
      className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-ink"
    >
      <svg viewBox="0 0 32 32" className="size-[19px]" fill="none" aria-hidden>
        <path
          d="M12 7v12a4 4 0 0 0 4 4"
          stroke="white"
          strokeWidth="3.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M20 7v12a4 4 0 0 0 4 4"
          className="stroke-accent"
          strokeWidth="3.1"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
};

const SetupNotice = ({ detail }: { detail: string }) => {
  return (
    <div className="rounded-2xl bg-warn-soft/60 px-6 py-5 text-[13px] text-ink ring-1 ring-inset ring-warn-line/60">
      <p className="font-semibold">
        Almost there. The demo needs its database.
      </p>
      <p className="mt-1 text-muted">{detail}</p>
      <p className="mt-2.5 text-muted">
        Set{" "}
        <code className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-[12px] text-ink ring-1 ring-inset ring-line">
          DATABASE_URL
        </code>{" "}
        (and{" "}
        <code className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-[12px] text-ink ring-1 ring-inset ring-line">
          ANTHROPIC_API_KEY
        </code>
        ) in your environment, then run{" "}
        <code className="rounded-md bg-surface px-1.5 py-0.5 font-mono text-[12px] text-ink ring-1 ring-inset ring-line">
          pnpm db:push &amp;&amp; pnpm db:seed
        </code>
        . See the README for the full setup.
      </p>
    </div>
  );
};

const Footer = () => {
  return (
    <footer className="mt-7 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4 text-[12px] text-faint">
      <p>
        Built with <span className="text-muted">Mastra</span> · investigator
        agent on <span className="font-mono text-muted">{PIPELINE_MODEL}</span>{" "}
        · Next.js · Supabase · Drizzle. Runs are stateless; nothing is written
        back.
      </p>
      <div className="flex items-center gap-2">
        <span className="font-medium text-muted">Dylan Mérigaud</span>
        <SocialLinks />
      </div>
    </footer>
  );
};
