import assert from "node:assert/strict";
import { test } from "node:test";
import { earlierBangladeshOrderDocument, nativeBangladeshOrderDocument } from "../src/lib/commerce/bd-order-document.ts";
import { orderDocumentPdf } from "../src/lib/commerce/bd-order-document-pdf.ts";

const date = new Date("2026-11-17T23:41:00Z");
const nativeOrder = {
  reference: "GB-RECEIPT-TEST", createdAt: date, status: "PLACED", fulfillmentStatus: "UNFULFILLED",
  marketId: "bd", currency: "BDT", subtotalMinor: 100000, discountMinor: 10000, deliveryMinor: 8000, taxMinor: 0,
  totalMinor: 98000, bangladeshShipment: null, bangladeshRefusedParcelReceipt: null,
  items: [{ productName: "GriipBuddy প্রো কেস", variantName: "নীল", sku: "CASE-001", quantity: 1, lineTotalMinor: 90000 }],
  payment: { status: "AWAITING_COLLECTION", currency: "BDT", method: "COD", amountMinor: 98000, collectedAt: null }, cases: [],
} satisfies Parameters<typeof nativeBangladeshOrderDocument>[0];

test("an unpaid COD order and unverified payment produce summaries", () => {
  const cod = nativeBangladeshOrderDocument(nativeOrder);
  assert.equal(cod.kind, "order-summary");
  assert.deepEqual(cod.payment, [{ label: "Amount due on delivery", minor: 98000 }]);
  const unverified = nativeBangladeshOrderDocument({ ...nativeOrder, payment: {
    ...nativeOrder.payment, method: "NAGAD", status: "AWAITING_VERIFICATION",
  } });
  assert.equal(unverified.kind, "order-summary");
  assert.deepEqual(unverified.payment, []);
});

test("a receipt keeps the original order total and counts only confirmed refunds", async () => {
  const order = { ...nativeOrder, fulfillmentStatus: "DELIVERED", payment: {
    ...nativeOrder.payment, status: "COLLECTED", collectedAt: date,
  }, cases: [{ refundConfirmedAt: null, refundAmountMinor: 21000 }, { refundConfirmedAt: date, refundAmountMinor: 23000 }] } as const;
  const receipt = nativeBangladeshOrderDocument({ ...order, cases: [...order.cases] });
  assert.equal(receipt.kind, "payment-receipt");
  assert.equal(receipt.total?.minor, 98000);
  assert.deepEqual(receipt.payment, [{ label: "Payment received", minor: 98000 }]);
  assert.deepEqual(receipt.refunds, [{ label: "Nov 18, 2026", minor: 23000 }]);
  assert.equal(receipt.netPaid?.minor, 75000);

  const full = nativeBangladeshOrderDocument({ ...nativeOrder, status: "CANCELLED", payment: {
    ...nativeOrder.payment, status: "REFUNDED",
  }, cases: [{ refundConfirmedAt: date, refundAmountMinor: 98000 }] });
  assert.equal(full.kind, "payment-receipt");
  assert.equal(full.netPaid?.minor, 0);
  assert.equal(full.title, "Payment receipt");
  assert.equal(full.items[0].title, nativeOrder.items[0].productName);
  const pdf = await orderDocumentPdf(full);
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.match(pdf.toString("latin1"), /\/Lang \(en\)/);
  assert.equal(pdf.subarray(-6).toString(), "%%EOF\n");
});

test("an earlier pre-order summary uses available facts without treating a recorded deposit as full payment", () => {
  const summary = earlierBangladeshOrderDocument({ id: "0123456789abcdef01234567", kind: "preorder", reference: "GB-PO-TEST",
    createdAt: date.toISOString(), status: "PENDING", statusLabel: "Waiting to arrive", paymentLabel: "Advance paid", amountMinor: null,
    currency: "BDT", trackingCode: null, items: [{ name: "iQOO case", quantity: 1 }] });
  assert.equal(summary.title, "Pre-order summary");
  assert.equal(summary.total, undefined);
  assert.deepEqual(summary.payment, []);
  assert.deepEqual(summary.items, [{ title: "iQOO case", quantity: 1, detail: "" }]);
});
