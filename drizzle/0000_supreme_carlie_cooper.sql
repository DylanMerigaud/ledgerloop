CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_number" text NOT NULL,
	"verdict" text NOT NULL,
	"tier" text NOT NULL,
	"trace" jsonb NOT NULL,
	"duration_ms" integer NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"gr_number" text NOT NULL,
	"po_number" text NOT NULL,
	"received_date" text NOT NULL,
	"line_items" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_number" text NOT NULL,
	"po_number" text,
	"vendor" text NOT NULL,
	"issue_date" text NOT NULL,
	"currency" text NOT NULL,
	"line_items" jsonb NOT NULL,
	"subtotal" numeric NOT NULL,
	"tax" numeric,
	"total" numeric NOT NULL,
	"scenario" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" text PRIMARY KEY NOT NULL,
	"po_number" text NOT NULL,
	"vendor" text NOT NULL,
	"currency" text NOT NULL,
	"line_items" jsonb NOT NULL,
	"total" numeric NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "agent_runs_invoice_idx" ON "agent_runs" USING btree ("invoice_number");