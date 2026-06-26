import assert from "node:assert/strict";
import { test } from "node:test";

import { Invoice, MatchResult, INVOICE_JSON_SCHEMA } from "@/lib/schema";

/**
 * Schema accept/reject tests — the single-source-of-truth guarantee in action.
 * If the model (or the DB, or a refactor) produces a shape the validator would
 * reject, these fail. They also confirm the JSON schema we hand the intake model
 * is well-formed and derived from the same object.
 */
const validInvoice = () => {
  return {
    invoiceNumber: "INV-1",
    poNumber: "PO-1",
    vendor: "Acme",
    issueDate: "2026-05-01",
    currency: "USD",
    lineItems: [
      { sku: "A", description: "thing", qty: 2, unitPrice: 10, amount: 20 },
    ],
    subtotal: 20,
    tax: null,
    total: 20,
  };
};

test("a well-formed invoice parses", () => {
  assert.doesNotThrow(() => Invoice.parse(validInvoice()));
});

test("optional poNumber/tax may be omitted", () => {
  const inv = validInvoice();
  delete (inv as Partial<typeof inv>).poNumber;
  delete (inv as Partial<typeof inv>).tax;
  assert.doesNotThrow(() => Invoice.parse(inv));
});

test("rejects an empty line-items array", () => {
  const inv = { ...validInvoice(), lineItems: [] };
  assert.equal(Invoice.safeParse(inv).success, false);
});

test("rejects a non-ISO currency", () => {
  const inv = { ...validInvoice(), currency: "dollars" };
  assert.equal(Invoice.safeParse(inv).success, false);
});

test("rejects a malformed date", () => {
  const inv = { ...validInvoice(), issueDate: "05/01/2026" };
  assert.equal(Invoice.safeParse(inv).success, false);
});

test("rejects unknown extra keys (strict)", () => {
  const inv = { ...validInvoice(), surprise: true };
  assert.equal(Invoice.safeParse(inv).success, false);
});

test("rejects a negative quantity", () => {
  const inv = validInvoice();
  inv.lineItems[0]!.qty = -1;
  assert.equal(Invoice.safeParse(inv).success, false);
});

test("MatchResult round-trips its own valid shape", () => {
  const m = {
    invoiceNumber: "INV-1",
    poNumber: "PO-1",
    matchType: "three_way" as const,
    verdict: "clean" as const,
    exceptions: [],
    maxVariancePct: 0,
    exceptionAmount: 0,
    currency: "USD",
    invoiceTotal: 20,
    department: "",
    vendor: "Acme",
  };
  assert.doesNotThrow(() => MatchResult.parse(m));
});

test("INVOICE_JSON_SCHEMA is an object schema without a $schema meta key", () => {
  assert.equal(typeof INVOICE_JSON_SCHEMA, "object");
  assert.equal(INVOICE_JSON_SCHEMA["type"], "object");
  assert.equal("$schema" in INVOICE_JSON_SCHEMA, false);
  // derived from the same object → it must mention the required top-level fields
  const props = (
    INVOICE_JSON_SCHEMA as { properties?: Record<string, unknown> }
  ).properties;
  assert.ok(props && "invoiceNumber" in props && "lineItems" in props);
});
