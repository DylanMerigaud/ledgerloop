/**
 * A curated org to SEED into a BambooHR sandbox (see scripts/seed-bamboo.ts).
 *
 * Not a clone of the 91-person sample data — a small, hand-designed org (~14) that
 * (a) forms a believable reporting tree and (b) deliberately plants the exact
 * data-quality problems the discovery pipeline detects, so a fresh seed always
 * gives the onboarding agent something real to find. That makes the demo
 * reproducible: wipe a trial, reseed, and the same story is there.
 *
 * Constraints baked in (learned from the live API):
 *   • `title` and `department` MUST be values that already exist as options in the
 *     BambooHR list fields. Every title below is from the sample account's Job
 *     Title list; every department from its Department list. Invented strings are
 *     silently dropped by the API.
 *   • The manager link (`reportsTo`) is set BY NAME, so names must be unique here.
 *
 * The planted issues (what the discovery surfaces):
 *   • a clean CEO → C-suite → manager → IC tree (the healthy backbone)
 *   • ONE second "root" with a blank title (Dana Vance) — looks like a real CEO
 *     to a naive importer, but has no manager and no title → flagged as a junk
 *     top-level record
 *   • ONE employee pointed at a manager who doesn't exist (Morgan Vega →
 *     "Riley Stone", intentionally absent). NOTE: BambooHR resolves `reportsTo`
 *     by name AT WRITE TIME and silently drops an unmatched name, so Morgan ends
 *     up with NO manager rather than a broken pointer. She therefore surfaces as
 *     an unexpected root (an IC with no manager — suspicious), which is the
 *     honest shape of this problem when the source is BambooHR. (The mapper still
 *     has dangling-manager detection for sources that DO emit broken ids.)
 */

export interface SeedPerson {
  firstName: string;
  lastName: string;
  /** Must exist in the BambooHR Job Title list. "" = deliberately blank. */
  title: string;
  /** Must exist in the BambooHR Department list. */
  department: string;
  /** Full "First Last" of the manager, or null for a tree root. */
  managerName: string | null;
}

/**
 * Every seeded employee is placed in this dedicated Division. It's how the seed
 * is scoped WITHOUT a local manifest: `reset` reads the org back and deletes only
 * the people in this division, so it's correct on any account, from any machine,
 * and never touches the sample staff. Division is a legitimate org field (not a
 * detourned tag), so it reads cleanly in BambooHR. The option is created once per
 * account by the seed script (see scripts/seed-bamboo.ts).
 *
 * Same constant the live adapter scopes reads to (`DEMO_CLIENT_DIVISION`), so the
 * onboarding agent reads exactly what the seed wrote.
 */
export { DEMO_CLIENT_DIVISION as SEED_DIVISION } from "@/lib/hris";

/** A manager name intentionally NOT seeded — BambooHR drops it, leaving an orphan. */
const ABSENT_MANAGER_NAME = "Riley Stone";

export const SEED_ORG: SeedPerson[] = [
  // ── Healthy backbone ──────────────────────────────────────────────────────
  {
    firstName: "Avery",
    lastName: "Brooks",
    title: "Founder and CEO",
    department: "Company",
    managerName: null, // the one true root
  },
  {
    firstName: "Cameron",
    lastName: "Diaz",
    title: "Chief Financial Officer",
    department: "Finance",
    managerName: "Avery Brooks",
  },
  {
    firstName: "Jordan",
    lastName: "Ellis",
    title: "Chief Operating Officer",
    department: "Operations",
    managerName: "Avery Brooks",
  },
  {
    firstName: "Taylor",
    lastName: "Nguyen",
    title: "VP of Sales",
    department: "Sales",
    managerName: "Jordan Ellis",
  },
  {
    firstName: "Sam",
    lastName: "Patel",
    title: "VP of Product",
    department: "Product",
    managerName: "Jordan Ellis",
  },
  {
    firstName: "Riley",
    lastName: "Carter",
    title: "Controller",
    department: "Finance",
    managerName: "Cameron Diaz",
  },
  {
    firstName: "Quinn",
    lastName: "Foster",
    title: "Sales Director",
    department: "Sales",
    managerName: "Taylor Nguyen",
  },
  {
    firstName: "Jamie",
    lastName: "Reyes",
    title: "Account Executive",
    department: "Sales",
    managerName: "Quinn Foster",
  },
  {
    firstName: "Drew",
    lastName: "Walsh",
    title: "Product Manager",
    department: "Product",
    managerName: "Sam Patel",
  },
  {
    firstName: "Casey",
    lastName: "Kim",
    title: "Software Engineer",
    department: "Product",
    managerName: "Drew Walsh",
  },
  {
    firstName: "Robin",
    lastName: "Shah",
    title: "Financial Analyst",
    department: "Finance",
    managerName: "Riley Carter",
  },
  // ── Planted issue 1: dangling manager (Riley Stone is never seeded) ────────
  {
    firstName: "Morgan",
    lastName: "Vega",
    title: "Accountant",
    department: "Finance",
    managerName: ABSENT_MANAGER_NAME,
  },
  // ── Planted issue 2: a second root with a blank title (orphan) ─────────────
  {
    firstName: "Dana",
    lastName: "Vance",
    title: "", // deliberately blank — the tell of a junk top-level record
    department: "Company",
    managerName: null,
  },
];
