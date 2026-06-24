import { test } from "node:test";
import assert from "node:assert/strict";
import { runIntake, type Extractor } from "./intake";
import type { Invoice } from "./schema";

/**
 * Intake tests — the "mock vision" coverage. The real extraction calls the
 * Anthropic vision API; here we inject a mock extractor so the whole intake path
 * (render → extract → reconcile-with-record / fail) is exercised offline.
 */

const SOURCE: Invoice = {
  invoiceNumber: "INV-9001",
  poNumber: "PO-9001",
  vendor: "Acme Corp",
  issueDate: "2026-05-01",
  currency: "USD",
  lineItems: [
    { sku: "A-1", description: "Widget", qty: 2, unitPrice: 10, amount: 20 },
  ],
  subtotal: 20,
  tax: null,
  total: 20,
};

// A render stub so no PDF is actually generated.
const render = async () => "ZmFrZS1wZGY=";

/** An extractor that returns a given invoice (or failure). */
function mockExtractor(invoice: Invoice): Extractor {
  return async () => ({ ok: true, invoice });
}

test("successful extraction returns the extracted invoice", async () => {
  const extracted: Invoice = { ...SOURCE, vendor: "Acme Corporation Ltd" };
  const res = await runIntake(SOURCE, {
    extract: mockExtractor(extracted),
    render,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.invoice.vendor, "Acme Corporation Ltd");
    // Header reconciles (invoiceNumber + poNumber + total all match the record).
    assert.equal(res.matchesRecord, true);
  }
});

test("extracted header differing from the record → matchesRecord false", async () => {
  const extracted: Invoice = { ...SOURCE, total: 999 };
  const res = await runIntake(SOURCE, {
    extract: mockExtractor(extracted),
    render,
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.matchesRecord, false);
});

test("the pipeline runs on the EXTRACTED data, not the source", async () => {
  // The model reads a different unit price than the record — runIntake must
  // return the model's number (that's the whole point: data comes from the read).
  const extracted: Invoice = {
    ...SOURCE,
    lineItems: [{ ...SOURCE.lineItems[0]!, unitPrice: 11, amount: 22 }],
    subtotal: 22,
    total: 22,
  };
  const res = await runIntake(SOURCE, {
    extract: mockExtractor(extracted),
    render,
  });
  assert.equal(res.ok, true);
  if (res.ok) assert.equal(res.invoice.lineItems[0]?.unitPrice, 11);
});

test("a validation failure surfaces as a failure (no fabricated data)", async () => {
  const res = await runIntake(SOURCE, {
    extract: async () => ({
      ok: false,
      kind: "validation",
      issues: ["total: expected a number"],
    }),
    render,
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /validation/i);
});

test("a refusal surfaces as a failure", async () => {
  const res = await runIntake(SOURCE, {
    extract: async () => ({ ok: false, kind: "refusal" }),
    render,
  });
  assert.equal(res.ok, false);
});

test("a timeout surfaces as a failure (does not hang)", async () => {
  const res = await runIntake(SOURCE, {
    // Never resolves → the internal timeout must win.
    extract: () => new Promise(() => {}),
    render,
    timeoutMs: 20,
  });
  assert.equal(res.ok, false);
});

test("a thrown extractor is caught, not propagated", async () => {
  const res = await runIntake(SOURCE, {
    extract: async () => {
      throw new Error("network down");
    },
    render,
  });
  assert.equal(res.ok, false);
});
