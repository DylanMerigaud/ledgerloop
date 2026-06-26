import assert from "node:assert/strict";
import { test } from "node:test";

import { GET } from "@/app/api/reset/route";

/**
 * The reset endpoint truncates + reseeds the database, so its auth guard is
 * security-critical: only the Vercel Cron (carrying `Authorization: Bearer
 * $CRON_SECRET`) may trigger it. These pin the 401 paths, which short-circuit
 * BEFORE any DB call — so they need no database. (The 200 path runs the real
 * reset and is verified live, not here.)
 *
 * The suite runs with SKIP_ENV_VALIDATION and no CRON_SECRET set, which is itself
 * the "secret unset → refuse everyone" case we want guaranteed: a misconfigured
 * deploy must not expose a public truncate button.
 */

const req = (auth?: string): Request =>
  new Request("https://example.com/api/reset", {
    headers: auth ? { authorization: auth } : {},
  });

test("rejects a request with no Authorization header", async () => {
  const res = await GET(req());
  assert.equal(res.status, 401);
});

test("rejects a wrong bearer token", async () => {
  const res = await GET(req("Bearer not-the-secret"));
  assert.equal(res.status, 401);
});

test("rejects a malformed Authorization header", async () => {
  const res = await GET(req("Basic abc123"));
  assert.equal(res.status, 401);
});

test("with CRON_SECRET unset, even a 'Bearer ' prefix is refused", async () => {
  // No secret configured in the test env → the route must refuse all callers
  // rather than match an empty/undefined secret.
  const res = await GET(req("Bearer "));
  assert.equal(res.status, 401);
});
