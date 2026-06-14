import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney, formatPct, formatDuration, humanize } from "./format";

test("formatMoney: 2dp + currency suffix, with thousands separators", () => {
  assert.equal(formatMoney(1234.5, "USD"), "1,234.50 USD");
  assert.equal(formatMoney(0, "EUR"), "0.00 EUR");
});

test("formatMoney: rounds half-cent up", () => {
  assert.equal(formatMoney(10.005, "USD"), "10.01 USD");
});

test("formatPct: one decimal place", () => {
  assert.equal(formatPct(0.073), "7.3%");
  assert.equal(formatPct(0.1), "10.0%");
});

test("formatDuration: ms under a second, seconds above", () => {
  assert.equal(formatDuration(820), "820ms");
  assert.equal(formatDuration(3400), "3.4s");
});

test("humanize: snake/kebab → Title Case", () => {
  assert.equal(humanize("qty_variance_po"), "Qty Variance Po");
  assert.equal(humanize("price-variance"), "Price Variance");
});
