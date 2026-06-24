/**
 * Capture the REAL BambooHR org payload to a committed fixture.
 *
 * This is the bridge that makes "recorded" mean "real, captured": it calls the
 * live BambooHR API via the SAME `fetchBambooReport` the production adapter uses,
 * then writes the raw response (plus a dated `_meta` provenance block) to
 * `db/fixtures/bamboohr/report.json`. `recordedHris` later replays that exact
 * payload through the same mapper. So the fixture is not a hand-written mock — it
 * is BambooHR's own output, frozen on the date below.
 *
 * Why this exists: the BambooHR trial key is short-lived. Capturing the fixture
 * while the key is alive means the demo (and CI, which has no key) keeps running
 * on real data after the key expires, with the README stating plainly that it's
 * a recorded snapshot.
 *
 * Run:  pnpm tsx scripts/capture-bamboo.ts   (reads creds from .env.local / .env)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fetchBambooReport, mapBambooReport } from "@/lib/hris";

/** Same env loading as eval/run.ts — native, no dotenv dep. */
function loadEnv(): void {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(path.join(process.cwd(), f));
    } catch {
      /* file absent — fine */
    }
  }
}

async function main(): Promise<void> {
  loadEnv();
  const key = process.env.BAMBOO_HR_API_KEY;
  const subdomain = process.env.BAMBOO_HR_SUBDOMAIN;
  if (!key || !subdomain) {
    console.error(
      "Missing BAMBOO_HR_API_KEY and/or BAMBOO_HR_SUBDOMAIN. Set them in .env.\n" +
        "(This script needs the LIVE trial key — it is the only step that does.)",
    );
    process.exit(1);
  }

  console.log(`Fetching org from ${subdomain}.bamboohr.com …`);
  const raw = await fetchBambooReport({ key, subdomain });

  // Validate the capture is usable BEFORE writing — a fixture that can't be
  // mapped is worse than no fixture. mapBambooReport throws on a bad shape.
  const org = mapBambooReport(raw, "bamboohr (recorded)");
  console.log(
    `Mapped OK: ${org.employees.length} active employees, ${org.issues.length} org issue(s) flagged.`,
  );

  // Provenance: the snapshot is real data; record exactly when/where from. The
  // subdomain and key are NOT written — only that a capture happened.
  const payload = {
    _meta: {
      source: "BambooHR API — POST /reports/custom",
      note: "Real API response captured from the live trial. Replayed offline by recordedHris(). Not a mock.",
      capturedAt: new Date().toISOString(),
    },
    ...(raw as Record<string, unknown>),
  };

  const outDir = path.join(process.cwd(), "db", "fixtures", "bamboohr");
  mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "report.json");
  writeFileSync(outFile, JSON.stringify(payload, null, 2) + "\n", "utf8");
  console.log(`Wrote ${path.relative(process.cwd(), outFile)}`);
}

main().catch((err: unknown) => {
  console.error("Capture failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
