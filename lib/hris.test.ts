import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";

import { mapBambooReport, recordedHris } from "@/lib/hris";
import { OrgChart } from "@/lib/schema";

/**
 * Two layers:
 *   1. Mapper logic on small, hand-built BambooHR-shaped payloads — deterministic,
 *      pins every cleanup rule (active filter, id-based edges, each issue kind).
 *   2. A loose smoke test against the REAL captured fixture — proves the live
 *      payload maps to a valid OrgChart without crashing. Loose on purpose: a
 *      re-capture changes the numbers, and we don't want a brittle snapshot.
 */

// A minimal report row helper — only the fields the mapper reads.
type Row = Record<string, string>;
const report = (employees: Row[]) => ({ employees });

test("maps a clean two-person org with one ID-based reporting edge", () => {
  const org = mapBambooReport(
    report([
      { id: "1", displayName: "Boss", jobTitle: "CEO", status: "Active" },
      {
        id: "2",
        displayName: "Worker",
        jobTitle: "Engineer",
        supervisorEId: "1",
        status: "Active",
      },
    ]),
    "test",
  );
  assert.equal(org.employees.length, 2);
  assert.equal(org.issues.length, 0);
  const worker = org.employees.find((e) => e.id === "2")!;
  assert.equal(worker.managerId, "1"); // resolved by id, not name
  const boss = org.employees.find((e) => e.id === "1")!;
  assert.equal(boss.managerId, null); // single clean root → not an issue
});

test("drops non-active rows so terminated staff never enter the hierarchy", () => {
  const org = mapBambooReport(
    report([
      { id: "1", displayName: "Boss", jobTitle: "CEO", status: "Active" },
      { id: "2", displayName: "Gone", status: "Inactive", supervisorEId: "1" },
    ]),
    "test",
  );
  assert.equal(org.employees.length, 1);
  assert.equal(org.employees[0]?.id, "1");
});

test("flags a dangling manager (supervisor id not an active employee)", () => {
  const org = mapBambooReport(
    report([
      { id: "1", displayName: "Boss", jobTitle: "CEO", status: "Active" },
      {
        id: "2",
        displayName: "Orphaned report",
        supervisorEId: "999",
        status: "Active",
      },
    ]),
    "test",
  );
  const issue = org.issues.find((i) => i.kind === "dangling-manager");
  assert.ok(issue, "expected a dangling-manager issue");
  assert.equal(issue.employeeId, "2");
});

test("flags a self-managed employee", () => {
  const org = mapBambooReport(
    report([
      { id: "1", displayName: "Boss", jobTitle: "CEO", status: "Active" },
      {
        id: "2",
        displayName: "Loop",
        supervisorEId: "2",
        status: "Active",
      },
    ]),
    "test",
  );
  assert.ok(org.issues.some((i) => i.kind === "self-managed"));
});

test("a single root is healthy; multiple roots are all flagged as orphans", () => {
  const oneRoot = mapBambooReport(
    report([
      { id: "1", displayName: "Solo", jobTitle: "CEO", status: "Active" },
    ]),
    "test",
  );
  assert.equal(oneRoot.issues.length, 0);

  const twoRoots = mapBambooReport(
    report([
      { id: "1", displayName: "Root A", status: "Active" },
      { id: "2", displayName: "Root B", status: "Active" },
    ]),
    "test",
  );
  const orphans = twoRoots.issues.filter((i) => i.kind === "orphan");
  assert.equal(orphans.length, 2);
});

test("a blank-title root is called out as junk; a titled root as needs-review", () => {
  const org = mapBambooReport(
    report([
      {
        id: "1",
        displayName: "Real CEO",
        jobTitle: "Founder and CEO",
        status: "Active",
      },
      { id: "2", displayName: "Junk Row", status: "Active" }, // no title
    ]),
    "test",
  );
  const junk = org.issues.find((i) => i.employeeId === "2");
  const titled = org.issues.find((i) => i.employeeId === "1");
  assert.match(junk!.detail, /junk top-level record/);
  assert.match(titled!.detail, /needs review/);
});

test("treats supervisorEId '0' / missing as no manager (a root), not a dangling edge", () => {
  const org = mapBambooReport(
    report([
      {
        id: "1",
        displayName: "Top",
        jobTitle: "CEO",
        supervisorEId: "0",
        status: "Active",
      },
    ]),
    "test",
  );
  assert.equal(org.employees[0]?.managerId, null);
  assert.equal(org.issues.length, 0);
});

test("derives a name from first/last when displayName is absent", () => {
  const org = mapBambooReport(
    report([
      {
        id: "1",
        firstName: "Ada",
        lastName: "Lovelace",
        jobTitle: "CEO",
        status: "Active",
      },
    ]),
    "test",
  );
  assert.equal(org.employees[0]?.name, "Ada Lovelace");
});

test("tolerates an empty / shapeless payload without throwing", () => {
  assert.equal(mapBambooReport({}, "test").employees.length, 0);
  assert.equal(mapBambooReport(null, "test").employees.length, 0);
});

// ── Layer 2: the real captured fixture ──────────────────────────────────────
// Skips cleanly if the fixture hasn't been captured (e.g. a fresh checkout that
// hasn't run the capture script), so the suite never fails for a missing file.
test("the recorded fixture maps to a valid OrgChart", async (t) => {
  const adapter = recordedHris();
  // recordedHris() points at db/fixtures/bamboohr/report.json by default.
  if (!existsSync("db/fixtures/bamboohr/report.json")) {
    t.skip("fixture missing — run pnpm fixture:build");
    return;
  }
  const org = await adapter.fetchOrg();
  // Valid against the schema (the real assertion — shape is correct).
  assert.doesNotThrow(() => OrgChart.parse(org));
  // Sanity: the seed-built demo org has its roster and at least one clean edge.
  assert.ok(org.employees.length > 10, "expected a populated org");
  assert.ok(
    org.employees.some((e) => e.managerId !== null),
    "expected at least one resolved reporting edge",
  );
  assert.equal(org.source, "bamboohr (recorded)");
});
