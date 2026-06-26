import {
  pgTable,
  text,
  jsonb,
  timestamp,
  integer,
  numeric,
  index,
} from "drizzle-orm/pg-core";

import type {
  LineItem,
  GoodsReceiptLine,
  TraceEvent,
} from "@/lib/schema-types";

/**
 * Drizzle schema — the four tables the spec calls for:
 *   invoices, purchase_orders, goods_receipts, agent_runs
 *
 * Two deliberate design points a CTO should notice:
 *
 *  1. The JSONB document columns are typed with `.$type<…>()` using the SAME
 *     inferred types as the Zod single source of truth (`lib/schema.ts`). The
 *     database rows, the model output, and the UI all speak one vocabulary —
 *     a line item is a `LineItem` everywhere, no parallel DB-only shape.
 *
 *  2. `agent_runs` is modelled as the PERSISTED shape of a pipeline execution
 *     (the trace + verdicts). It's the schema's key visual asset — the execution
 *     log. BUT on the public demo it is intentionally left EMPTY and never
 *     written: running the pipeline streams the trace to the visitor and forgets
 *     (see the route + README on why). The table documents what a stateful
 *     deployment would record, while the live demo stays pristine for every
 *     visitor. Reads in this app touch only the three document tables.
 */

/* Line-item arrays are stored as typed JSONB rather than child tables — these
   documents are read whole, never queried by line, so JSONB keeps the seed and
   the read layer simple while staying fully typed. */

export const invoices = pgTable("invoices", {
  id: text("id").primaryKey(), // = invoiceNumber, stable + human-readable
  invoiceNumber: text("invoice_number").notNull(),
  poNumber: text("po_number"),
  vendor: text("vendor").notNull(),
  issueDate: text("issue_date").notNull(), // ISO YYYY-MM-DD (matches Zod IsoDate)
  currency: text("currency").notNull(),
  lineItems: jsonb("line_items").$type<LineItem[]>().notNull(),
  subtotal: numeric("subtotal", { mode: "number" }).notNull(),
  tax: numeric("tax", { mode: "number" }),
  total: numeric("total", { mode: "number" }).notNull(),
  /** Demo metadata: a short label for the queue (e.g. "Price mismatch"). Not business data. */
  scenario: text("scenario"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const purchaseOrders = pgTable("purchase_orders", {
  id: text("id").primaryKey(), // = poNumber
  poNumber: text("po_number").notNull(),
  vendor: text("vendor").notNull(),
  currency: text("currency").notNull(),
  lineItems: jsonb("line_items").$type<LineItem[]>().notNull(),
  total: numeric("total", { mode: "number" }).notNull(),
  /** The buying department, so the approval workflow can route a department review.
      Defaults to '' (no department) — a PO without one routes normally. */
  department: text("department").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const goodsReceipts = pgTable("goods_receipts", {
  id: text("id").primaryKey(), // = grNumber
  grNumber: text("gr_number").notNull(),
  poNumber: text("po_number").notNull(),
  receivedDate: text("received_date").notNull(),
  lineItems: jsonb("line_items").$type<GoodsReceiptLine[]>().notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

/**
 * The execution log. Each row = one full pipeline run for one invoice: its final
 * verdict/tier and the ordered trace of agent steps. Deliberately UNWRITTEN by
 * the public demo (kept stateless), but fully modelled so the schema reflects a
 * real stateful deployment and the trace has a canonical persisted shape.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: text("id").primaryKey(),
    invoiceNumber: text("invoice_number").notNull(),
    /** Final routing verdict, e.g. "clean" / "exception" / "duplicate". */
    verdict: text("verdict").notNull(),
    /** Final approver tier, e.g. "auto" / "manager" / "director" / "blocked". */
    tier: text("tier").notNull(),
    /** The ordered trace, same `TraceEvent` shape streamed to the browser. */
    trace: jsonb("trace").$type<TraceEvent[]>().notNull(),
    durationMs: integer("duration_ms").notNull(),
    model: text("model").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index("agent_runs_invoice_idx").on(t.invoiceNumber)],
);

/** Row types inferred from the table definitions (select shape). */
export type InvoiceRow = typeof invoices.$inferSelect;
export type PurchaseOrderRow = typeof purchaseOrders.$inferSelect;
export type GoodsReceiptRow = typeof goodsReceipts.$inferSelect;
export type AgentRunRow = typeof agentRuns.$inferSelect;
