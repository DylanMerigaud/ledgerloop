/**
 * Build the recorded HRIS fixture FROM the seed definition — `tsx
 * scripts/build-recorded-fixture.ts`.
 *
 * The recorded fixture must mirror the SAME demo the live adapter reads (the seeded
 * "LedgerLoop Demo" org of ~13), not the trial account's whole sample staff. Rather
 * than depend on a trial key to re-capture, we render `SEED_ORG` into the exact
 * BambooHR `POST /reports/custom` shape the mapper consumes, scoped to the demo
 * division — so recorded == seed, deterministic, key-free, and the planted issues
 * (the orphan, the blank-title root) survive because we reproduce BambooHR's own
 * write-time behaviour (an unmatched manager name is dropped → no supervisorEId).
 *
 * This is NOT a live capture; the file's `_meta.note` says so plainly.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { SEED_ORG, SEED_DIVISION } from "@/db/fixtures/bamboohr/seed-org";

type BambooRow = {
  id: string;
  firstName: string;
  lastName: string;
  displayName: string;
  jobTitle: string | null;
  department: string | null;
  division: string;
  supervisorEId: string | null;
  status: "Active";
};

const fullName = (p: { firstName: string; lastName: string }): string =>
  `${p.firstName} ${p.lastName}`;

const build = (): void => {
  // Stable ids by seed order (BambooHR uses string ids).
  const idByName = new Map<string, string>();
  SEED_ORG.forEach((p, i) => idByName.set(fullName(p), String(i + 100)));

  const employees: BambooRow[] = SEED_ORG.map((p, i) => {
    // Resolve the manager by name to an id. An unmatched name (the intentionally
    // absent "Riley Stone") resolves to null — exactly what BambooHR does on write,
    // which is what makes Morgan Vega surface as an orphan.
    const supervisorEId =
      p.managerName !== null ? (idByName.get(p.managerName) ?? null) : null;
    return {
      id: String(i + 100),
      firstName: p.firstName,
      lastName: p.lastName,
      displayName: fullName(p),
      jobTitle: p.title === "" ? null : p.title,
      department: p.department,
      division: SEED_DIVISION,
      supervisorEId,
      status: "Active",
    };
  });

  const payload = {
    _meta: {
      source: "Built from SEED_ORG (scripts/build-recorded-fixture.ts)",
      note: "NOT a live capture. Rendered from the seed definition into BambooHR's report shape, scoped to the demo division, so the recorded adapter replays the SAME org the seed writes (and the live adapter reads). Deterministic and key-free.",
      builtAt: new Date().toISOString(),
      division: SEED_DIVISION,
      employeeCount: employees.length,
    },
    title: "LedgerLoop Demo org",
    fields: [
      "id",
      "firstName",
      "lastName",
      "displayName",
      "jobTitle",
      "department",
      "division",
      "supervisorEId",
      "status",
    ],
    employees,
  };

  const out = path.join(
    process.cwd(),
    "db",
    "fixtures",
    "bamboohr",
    "report.json",
  );
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(payload, null, 2) + "\n");
  console.log(`Wrote ${employees.length} employees to ${out}`);
};

build();
