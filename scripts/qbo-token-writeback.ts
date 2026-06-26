/**
 * Persist QBO's rotated refresh token back to the local env file.
 *
 * QuickBooks rotates the refresh token on refresh (lib/erp.ts explains), so after
 * a seed/capture run the value in .env is stale and the next process would 401.
 * Both scripts call this at the end: if a rotation happened, rewrite the
 * QBO_REFRESH_TOKEN line in .env.local (or .env) so the next run reuses it.
 *
 * Only the local file is touched, and only that one line — never printed, never
 * committed (.env* is gitignored).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { qboRotatedRefreshToken } from "@/lib/erp";

export const persistRotatedRefreshToken = (): void => {
  const rotated = qboRotatedRefreshToken();
  if (!rotated) return;

  const candidates = [".env.local", ".env"].map((f) =>
    path.join(process.cwd(), f),
  );
  const file = candidates.find((f) => existsSync(f));
  if (!file) return;

  const original = readFileSync(file, "utf8");
  const line = `QBO_REFRESH_TOKEN=${rotated}`;
  const next = /^QBO_REFRESH_TOKEN=.*$/m.test(original)
    ? original.replace(/^QBO_REFRESH_TOKEN=.*$/m, line)
    : original.replace(/\n*$/, `\n${line}\n`);
  if (next !== original) {
    writeFileSync(file, next, "utf8");
    console.log(
      `Refresh token rotated — updated QBO_REFRESH_TOKEN in ${path.basename(file)}.`,
    );
  }
};
