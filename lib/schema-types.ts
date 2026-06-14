/**
 * Type-only re-export of the pipeline schema's inferred types used by the
 * persistence layer.
 *
 * The Drizzle schema imports from here so it pulls *types only* — not the Zod
 * runtime or `zod-to-json-schema` that `lib/schema.ts` also wires up. `import
 * type` from this barrel keeps the DB layer free of unnecessary runtime weight
 * while still sharing one source of truth for the shapes. (Other consumers import
 * their stage types straight from `lib/schema` / `lib/trace`.)
 */
export type { LineItem, GoodsReceiptLine } from "./schema";
export type { TraceEvent } from "./trace";
