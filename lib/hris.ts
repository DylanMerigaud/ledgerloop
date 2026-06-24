import { readFileSync } from "node:fs";
import path from "node:path";
import { Employee, OrgChart, type OrgIssue } from "./schema";
import { nonNull } from "./assert";

/**
 * HRIS adapter — the onboarding side's integration seam.
 *
 * The onboarding discovery agent needs one thing from a client's HR system: the
 * org, normalised. Who works here, their title/department, and who they report
 * to. From that the agent derives an approval matrix (no HRIS stores "approval
 * authority" natively). Everything vendor-specific stops at this file — the agent
 * imports `HrisAdapter` and `OrgChart`, never a BambooHR field name. Swap
 * `bambooHris` for a `workdayHris` implementing the same interface and nothing
 * downstream changes. This is the exact mirror of the ERP seam in `erp.ts`.
 *
 * Two implementations, both PURE (no env reads, no knowledge of each other):
 *   • `bambooHris(creds)`  — live HTTP against the real BambooHR API.
 *   • `recordedHris()`     — replays a fixture captured FROM that same live API.
 *
 * "Recorded" is not a mock. The fixture in `db/fixtures/bamboohr/` is the real
 * API's real response, captured on a dated run via `scripts/capture-bamboo.ts`,
 * which is itself `bambooHris` calling the live API. Same client, same mapper —
 * the only difference is whether the bytes arrive over HTTPS now or were frozen
 * to disk earlier. That's what lets a 7-day trial key produce a demo that still
 * runs (and a CI that has no key at all) without anyone pretending it's live when
 * it isn't. The README says exactly which it is.
 *
 * @public
 */
export interface HrisAdapter {
  readonly name: string;
  /** Fetch the normalised org. Throws only on transport/parse failure. */
  fetchOrg(): Promise<OrgChart>;
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  The vendor's wire shape (BambooHR) — confined to this file
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * What BambooHR's `POST /reports/custom` returns for the fields we request. One
 * call yields the whole org with ID-based reporting edges. Fields are stringly
 * (BambooHR returns numbers as strings) and absent values come back as "" or are
 * omitted, so every field is optional/loose here and tightened by the mapper.
 */
interface BambooReportRow {
  id?: string;
  firstName?: string;
  lastName?: string;
  displayName?: string;
  jobTitle?: string;
  department?: string;
  division?: string;
  supervisorEId?: string;
  supervisorEmail?: string;
  /** "Active" | "Inactive" — terminated staff would pollute the hierarchy. */
  status?: string;
}

interface BambooReport {
  employees?: BambooReportRow[];
}

/** The exact fields the report request asks BambooHR for. */
const BAMBOO_REPORT_FIELDS = [
  "id",
  "firstName",
  "lastName",
  "displayName",
  "jobTitle",
  "department",
  "division",
  "supervisorEId",
  "supervisorEmail",
  "status",
] as const;

/* ────────────────────────────────────────────────────────────────────────── *
 *  The shared mapper — vendor shape → internal OrgChart
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Turn a raw BambooHR custom-report payload into our `OrgChart`. This is the ONE
 * place BambooHR's shape becomes our shape; it runs identically on live bytes and
 * on replayed fixture bytes, so the two adapters can't drift. Pure and
 * synchronous — easy to test against the captured fixture.
 *
 * Two real-world cleanups happen here, both deliberate:
 *   1. Drop non-active rows. The report returns terminated employees (status !=
 *      "Active"); including them would invent phantom managers and dead branches.
 *   2. Resolve reporting edges by ID and FLAG what doesn't resolve, rather than
 *      guessing. A `supervisorEId` pointing at an id that isn't in the active set
 *      (a dangling edge), a self-reference, or a non-root with no manager all
 *      become `OrgIssue`s for a human — the forward-deployed-engineer's actual
 *      onboarding work, made explicit.
 */
export function mapBambooReport(
  raw: unknown,
  source: string,
  /**
   * Optional division to scope to — the way we read ONE client's org out of a
   * shared sandbox. When set, only employees in that division are kept (and
   * reporting edges to anyone outside it become dangling, correctly surfaced).
   * Omitted = the whole account (the recorded sample org).
   */
  division?: string,
): OrgChart {
  const rows = (raw as BambooReport)?.employees ?? [];

  // 1. Keep active rows that have an id; normalise each field. When a division
  //    scope is given, keep only that division — this is how one client's org is
  //    isolated from the rest of the sandbox.
  const active = rows.filter(
    (r) =>
      (r.status ?? "Active") === "Active" &&
      r.id &&
      (division === undefined || (r.division ?? "") === division),
  );
  const employees = active.map((r) => {
    const name =
      (r.displayName && r.displayName.trim()) ||
      [r.firstName, r.lastName].filter(Boolean).join(" ").trim() ||
      `Employee ${r.id}`;
    const managerId =
      r.supervisorEId && r.supervisorEId !== "0" ? r.supervisorEId : null;
    return Employee.parse({
      // `active` was filtered on `r.id` being present, so it's a string here.
      id: nonNull(r.id, "active row has an id (filtered above)"),
      name,
      title: r.jobTitle?.trim() ?? "",
      department: r.department?.trim() ?? "",
      division: r.division?.trim() ?? "",
      managerId,
    });
  });

  // 2. Resolve edges by id; collect the ones that don't resolve.
  const byId = new Map(employees.map((e) => [e.id, e]));
  const issues: OrgIssue[] = [];
  for (const e of employees) {
    if (e.managerId === null) {
      // No manager. Fine for the top of the tree; suspicious otherwise. We can't
      // know which is the "real" root, so we only flag when there's clearly more
      // than one such person (handled after the loop).
      continue;
    }
    if (e.managerId === e.id) {
      issues.push({
        employeeId: e.id,
        employeeName: e.name,
        kind: "self-managed",
        detail: `${e.name} is listed as their own manager.`,
      });
      continue;
    }
    if (!byId.has(e.managerId)) {
      issues.push({
        employeeId: e.id,
        employeeName: e.name,
        kind: "dangling-manager",
        detail: `${e.name}'s manager id (${e.managerId}) is not an active employee.`,
      });
    }
  }

  // Roots = people with no manager. Exactly one is healthy (the CEO). The
  // deterministic layer can't know WHICH of several roots is the real top — that
  // judgement (by title/seniority) is the agent's job — so when there's more than
  // one it surfaces them all for resolution. A blank title on a root is called out
  // explicitly: it's the clearest tell of a junk top-level record, as opposed to a
  // genuine second executive the agent will have to reason about.
  const roots = employees.filter((e) => e.managerId === null);
  if (roots.length > 1) {
    for (const r of roots) {
      const blank = r.title.trim() === "";
      issues.push({
        employeeId: r.id,
        employeeName: r.name,
        kind: "orphan",
        detail: blank
          ? `${r.name} has no manager and no job title — likely a junk top-level record (1 of ${roots.length} roots; an org should have one).`
          : `${r.name} (${r.title}) has no manager — 1 of ${roots.length} roots; only the CEO should be at the top, so this needs review.`,
      });
    }
  }

  return OrgChart.parse({ source, employees, issues });
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  Live adapter — real BambooHR
 * ────────────────────────────────────────────────────────────────────────── */

/** @public — credentials a live BambooHR adapter needs. */
export interface BambooCreds {
  /** Company subdomain: the `neige` in `neige.bamboohr.com`. */
  subdomain: string;
  /** API key — sent as the Basic-auth username, password is any value. */
  key: string;
}

/**
 * Live BambooHR adapter. One `POST /reports/custom` returns the whole org with
 * ID-based reporting edges (far cheaper than per-employee calls). Auth is HTTP
 * Basic with the API key as username and any password (BambooHR's scheme).
 *
 * @public — the integration seam: swap this for a `workdayHris` implementing
 * `HrisAdapter` and nothing downstream changes (cf. `erp.ts`).
 */
export function bambooHris(creds: BambooCreds, division?: string): HrisAdapter {
  return {
    name: division ? `bamboohr (${division})` : "bamboohr",
    async fetchOrg() {
      const raw = await fetchBambooReport(creds);
      return mapBambooReport(raw, "bamboohr", division);
    },
  };
}

/** The raw HTTP call, exported so the capture script records the exact payload. */
export async function fetchBambooReport(creds: BambooCreds): Promise<unknown> {
  const auth = Buffer.from(`${creds.key}:x`).toString("base64");
  const url = `https://${creds.subdomain}.bamboohr.com/api/v1/reports/custom?format=JSON`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Basic ${auth}`,
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ title: "orgchart", fields: BAMBOO_REPORT_FIELDS }),
  });
  if (!res.ok) {
    throw new Error(
      `BambooHR report failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
  return res.json();
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  Recorded adapter — replays the captured real payload
 * ────────────────────────────────────────────────────────────────────────── */

const FIXTURE_PATH = path.join(
  process.cwd(),
  "db",
  "fixtures",
  "bamboohr",
  "report.json",
);

/**
 * Replays the captured BambooHR payload from disk through the SAME mapper the
 * live adapter uses. The fixture is real API output (see the file's `_meta`).
 */
export function recordedHris(fixturePath: string = FIXTURE_PATH): HrisAdapter {
  return {
    name: "bamboohr (recorded)",
    async fetchOrg() {
      const raw: unknown = JSON.parse(readFileSync(fixturePath, "utf8"));
      return mapBambooReport(raw, "bamboohr (recorded)");
    },
  };
}

/* ────────────────────────────────────────────────────────────────────────── *
 *  The single decision point
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The division a demo client's org lives under in the shared BambooHR sandbox.
 * The live adapter scopes to it so onboarding reads ONE clean client org (the
 * seeded tree) instead of the whole account's sample staff. The seed script
 * stamps every seeded employee with this division — same constant, one source.
 */
export const DEMO_CLIENT_DIVISION = "LedgerLoop Demo";

/**
 * The ONLY place the live-vs-recorded choice is made. Live (scoped to the demo
 * client's division) when both creds are present (you, with the trial key);
 * recorded — the full captured sample org — otherwise (CI, a teammate, after the
 * trial expires). Everything else in the app calls this and is oblivious — that's
 * what keeps the fallback from leaking `if (key)` across the codebase.
 *
 * @public — the entry point the onboarding flow uses to read an org.
 */
export function defaultHris(): HrisAdapter {
  const key = process.env.BAMBOO_HR_API_KEY;
  const subdomain = process.env.BAMBOO_HR_SUBDOMAIN;
  return key && subdomain
    ? bambooHris({ key, subdomain }, DEMO_CLIENT_DIVISION)
    : recordedHris();
}
