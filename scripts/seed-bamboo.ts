/**
 * Seed a curated org into a BambooHR sandbox — and tear it back down.
 *
 *   pnpm hris:seed    create SEED_ORG in BambooHR, all under the SEED_DIVISION
 *   pnpm hris:reset   delete every employee currently in the SEED_DIVISION
 *
 * Why this exists:
 *   • Disaster recovery — the trial key is short-lived. If the account dies, spin
 *     a fresh trial and reseed; the demo org is back, identical, in one command.
 *   • Client trials — point it at a prospect's empty sandbox to stand up a
 *     realistic org the onboarding agent can then discover.
 *
 * Scoping by a dedicated Division (not a local file): BambooHR has no isolated
 * environments inside an account, so "what we own" is marked ON THE SERVER —
 * every seeded person is placed in the `SEED_DIVISION`, and `reset` reads the org
 * back and deletes ONLY the people in that division. That's correct on any
 * account, from any machine, with nothing to lose locally, and it never clears
 * demo data or touches the sample staff. Division is a real org field, so it
 * reads cleanly in BambooHR (unlike stashing a marker in a name/nickname).
 *
 * The BambooHR write recipe (verified against the live API):
 *   1. PUT  /meta/lists/{divisionFieldId}     → ensure the SEED_DIVISION option
 *      exists. New options are added with a `value` key; existing options must be
 *      echoed back by id or the PUT drops them (replace semantics).
 *   2. POST /employees/                        → create the person (flat: name).
 *      The new id comes back in the Location header.
 *   3. POST /employees/{id}/tables/jobInfo     → set division/title/department/
 *      manager. title & department & division are LIST fields (values must exist
 *      as options); the manager field is `reportsTo` and takes the display NAME.
 * Hence two passes: create everyone first (so manager names resolve), then set
 * job info with reportsTo.
 */
import path from "node:path";

import { z } from "zod";

import {
  SEED_ORG,
  SEED_DIVISION,
  type SeedPerson,
} from "@/db/fixtures/bamboohr/seed-org";
import { nonNull } from "@/lib/assert";

/** Same env loading as eval/run.ts — native, no dotenv dep. */
const loadEnv = (): void => {
  for (const f of [".env.local", ".env"]) {
    try {
      process.loadEnvFile(path.join(process.cwd(), f));
    } catch {
      /* file absent — fine */
    }
  }
};

type Creds = {
  subdomain: string;
  key: string;
};

const creds = (): Creds => {
  const key = process.env.BAMBOO_HR_API_KEY;
  const subdomain = process.env.BAMBOO_HR_SUBDOMAIN;
  if (!key || !subdomain) {
    console.error("Missing BAMBOO_HR_API_KEY / BAMBOO_HR_SUBDOMAIN in .env.");
    process.exit(1);
  }
  return { key, subdomain };
};

const api = (c: Creds, p: string): string => {
  return `https://${c.subdomain}.bamboohr.com/api/v1${p}`;
};

const authHeader = (c: Creds): string => {
  return `Basic ${Buffer.from(`${c.key}:x`).toString("base64")}`;
};

const ListOption = z.object({
  id: z.number(),
  name: z.string().nullable(),
  archived: z.enum(["yes", "no"]),
});
type ListOption = z.infer<typeof ListOption>;

/** Shape of GET /meta/lists we rely on (extra fields ignored). */
const MetaLists = z.array(
  z.object({
    alias: z.string(),
    fieldId: z.number(),
    options: z.array(ListOption),
  }),
);

/**
 * Make sure the SEED_DIVISION exists as a Division option, creating it if needed.
 * The list PUT replaces the option set, so we echo every existing option back by
 * id and append ours with a `value` key (the format BambooHR accepts for a new
 * option). Idempotent: a no-op when the option is already present.
 */
const ensureDivision = async (c: Creds): Promise<void> => {
  const res = await fetch(api(c, "/meta/lists/"), {
    headers: { authorization: authHeader(c), accept: "application/json" },
  });
  if (!res.ok) throw new Error(`meta/lists failed: HTTP ${res.status}`);
  const lists = MetaLists.parse(await res.json());
  const division = lists.find((l) => l.alias === "division");
  if (!division) throw new Error("no 'division' list field on this account");

  if (division.options.some((o) => o.name === SEED_DIVISION)) {
    console.log(`Division "${SEED_DIVISION}" already exists.`);
    return;
  }

  // Echo existing options by id (so the replace-PUT doesn't drop them), append ours.
  const options: Record<string, unknown>[] = division.options
    .filter((o) => o.name !== null) // skip any prior junk/blank options
    .map((o) => ({ id: o.id, value: o.name, archived: o.archived }));
  options.push({ value: SEED_DIVISION });

  const put = await fetch(api(c, `/meta/lists/${division.fieldId}`), {
    method: "PUT",
    headers: {
      authorization: authHeader(c),
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ options }),
  });
  if (!put.ok)
    throw new Error(`creating division option failed: HTTP ${put.status}`);
  console.log(`Created Division option "${SEED_DIVISION}".`);
};

/** Create one employee (flat). Returns the new BambooHR id from the Location header. */
const createEmployee = async (c: Creds, p: SeedPerson): Promise<string> => {
  const res = await fetch(api(c, "/employees/"), {
    method: "POST",
    headers: {
      authorization: authHeader(c),
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ firstName: p.firstName, lastName: p.lastName }),
  });
  if (res.status !== 201) {
    throw new Error(
      `create ${p.firstName} ${p.lastName} failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const location = res.headers.get("location") ?? "";
  const id = location.match(/employees\/(\d+)/)?.[1];
  if (!id) throw new Error(`no id in Location header for ${p.firstName}`);
  return id;
};

/** Set division/title/department/manager via the jobInfo table (the only path that sticks). */
const setJobInfo = async (
  c: Creds,
  id: string,
  p: SeedPerson,
): Promise<void> => {
  const body: Record<string, string> = {
    date: "2026-01-01",
    department: p.department,
    division: SEED_DIVISION, // the scoping marker — every seeded person carries it
  };
  // Title is a list field — only send it when non-blank (a blank is intentional
  // for the planted orphan and would just be dropped anyway).
  if (p.title) body.jobTitle = p.title;
  // reportsTo takes the manager's display name, not an id.
  if (p.managerName) body.reportsTo = p.managerName;

  const res = await fetch(api(c, `/employees/${id}/tables/jobInfo`), {
    method: "POST",
    headers: {
      authorization: authHeader(c),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `jobInfo for ${p.firstName} ${p.lastName} failed: HTTP ${res.status}`,
    );
  }
};

/** Everyone currently in the SEED_DIVISION (the scope of seed/reset). */
const seededEmployees = async (
  c: Creds,
): Promise<{ id: string; name: string }[]> => {
  const res = await fetch(api(c, "/reports/custom?format=JSON"), {
    method: "POST",
    headers: {
      authorization: authHeader(c),
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: "seed-scope",
      fields: ["id", "displayName", "division"],
    }),
  });
  if (!res.ok) throw new Error(`scope report failed: HTTP ${res.status}`);
  const data = z
    .object({
      employees: z.array(
        z.object({
          id: z.string(),
          displayName: z.string().optional(),
          division: z.string().optional(),
        }),
      ),
    })
    .parse(await res.json());
  return data.employees
    .filter((e) => e.division === SEED_DIVISION)
    .map((e) => ({ id: String(e.id), name: e.displayName ?? `id ${e.id}` }));
};

const seed = async (): Promise<void> => {
  const c = creds();
  await ensureDivision(c);

  const already = await seededEmployees(c);
  if (already.length > 0) {
    console.error(
      `${already.length} employee(s) already in "${SEED_DIVISION}". Run "pnpm hris:reset" first to avoid duplicates.`,
    );
    process.exit(1);
  }

  console.log(`Seeding ${SEED_ORG.length} employees into "${SEED_DIVISION}" …`);

  // Pass 1 — create everyone (so manager names exist before we link them).
  const created = new Map<string, string>(); // "First Last" → id
  for (const p of SEED_ORG) {
    const id = await createEmployee(c, p);
    created.set(`${p.firstName} ${p.lastName}`, id);
    console.log(`  + ${p.firstName} ${p.lastName} (id ${id})`);
  }

  // Pass 2 — set job info incl. division + the reporting edge.
  for (const p of SEED_ORG) {
    const id = nonNull(
      created.get(`${p.firstName} ${p.lastName}`),
      "every person was created in pass 1",
    );
    await setJobInfo(c, id, p);
    const rel = p.managerName ? ` → ${p.managerName}` : " (root)";
    console.log(
      `  · ${p.firstName} ${p.lastName}: ${p.title || "(no title)"}${rel}`,
    );
  }

  console.log(
    `\nDone. ${SEED_ORG.length} employees seeded into "${SEED_DIVISION}".\n` +
      `Deliberate issues for the discovery agent: an employee pointed at a\n` +
      `non-existent manager (surfaces as an unexpected root) and a blank-title second root.`,
  );
};

const reset = async (): Promise<void> => {
  const c = creds();
  const targets = await seededEmployees(c);
  if (targets.length === 0) {
    console.log(`Nothing to reset — no employees in "${SEED_DIVISION}".`);
    return;
  }
  console.log(`Deleting ${targets.length} employee(s) in "${SEED_DIVISION}":`);
  for (const t of targets) console.log(`  - ${t.name} (${t.id})`);
  let failed = 0;
  for (const t of targets) {
    const res = await fetch(api(c, `/employees/${t.id}`), {
      method: "DELETE",
      headers: { authorization: authHeader(c), accept: "application/json" },
    });
    if (res.status !== 204 && res.status !== 200) {
      failed++;
      console.log(`  ! could not delete ${t.id}: HTTP ${res.status}`);
    }
  }
  console.log(
    failed === 0
      ? `Removed all ${targets.length}.`
      : `${failed} could not be deleted (see above).`,
  );
};

const main = async (): Promise<void> => {
  loadEnv();
  const cmd = process.argv[2];
  if (cmd === "reset") {
    await reset();
  } else if (cmd === "seed" || cmd === undefined) {
    await seed();
  } else {
    console.error(`Unknown command "${cmd}". Use: seed | reset`);
    process.exit(1);
  }
};

main().catch((err: unknown) => {
  console.error("Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
