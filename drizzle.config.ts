import { defineConfig } from "drizzle-kit";

/**
 * Drizzle Kit config — drives `pnpm db:generate` (emit SQL migrations from the
 * schema) and `pnpm db:push` (apply the schema to the database). The connection
 * string comes from the environment so nothing DB-specific is committed.
 */
export default defineConfig({
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "",
  },
  // Keep the generated SQL readable in PRs.
  verbose: true,
  strict: true,
});
