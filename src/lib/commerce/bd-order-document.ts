import type { CurrencyCode, PaymentStatus, Prisma } from "../../generated/prisma/client.ts";
import type { LegacyOrder } from "../marketplace/bd-order-hub-bridge.ts";
import { cashDueOnDelivery, customerOrderDate, customerOrderStatus, customerPaymentMethod, customerPaymentStatus } from "./account-order.ts";

export function bangladeshOrderDocumentKind(payment?: { status: PaymentStatus; currency: CurrencyCode } | null) {
  return payment?.currency === "BDT" && ["COLLECTED", "PAID", "REFUND_PENDING", "REFUNDED"].includes(payment.status)
    ? "payment-receipt" : "order-summary";
}

export const bangladeshDocumentOrderSelect = {
  reference: true, createdAt: true, status: true, fulfillmentStatus: true, marketId: true, currency: true,
  subtotalMinor: true, discountMinor: true, deliveryMinor: true, taxMinor: true, totalMinor: true,
  bangladeshShipment: { select: { status: true } },
  bangladeshRefusedParcelReceipt: { select: { receivedAt: true } },
  items: { orderBy: [{ sku: "asc" }, { id: "asc" }], select: {
    productName: true, variantName: true, sku: true, quantity: true, lineTotalMinor: true,
  } },
  payment: { select: { status: true, method: true, currency: true, amountMinor: true, collectedAt: true } },
  cases: { where: { refundConfirmedAt: { not: null }, refundAmountMinor: { gt: 0 } }, orderBy: { refundConfirmedAt: "asc" },
    select: { refundConfirmedAt: true, refundAmountMinor: true } },
} satisfies Prisma.OrderSelect;

type NativeDocumentOrder = Prisma.OrderGetPayload<{ select: typeof bangladeshDocumentOrderSelect }>;
type DocumentField = { label: string; value: string };
type DocumentAmount = { label: string; minor: number };
type DocumentItem = { title: string; detail: string; quantity: number; minor?: number };

export type BangladeshOrderDocument = {
  kind: ReturnType<typeof bangladeshOrderDocumentKind>;
  title: string;
  reference: string;
  details: DocumentField[];
  items: DocumentItem[];
  breakdown: DocumentAmount[];
  total?: DocumentAmount;
  payment: DocumentAmount[];
  refunds: DocumentAmount[];
  netPaid?: DocumentAmount;
  note?: string;
};

export function nativeBangladeshOrderDocument(order: NativeDocumentOrder): BangladeshOrderDocument {
  const date = (value: Date) => customerOrderDate(value, "bd", "en");
  const payment = order.payment?.currency === "BDT" ? order.payment : null;
  const kind = bangladeshOrderDocumentKind(payment);
  const isReceipt = kind === "payment-receipt";
  const due = cashDueOnDelivery({ ...order, payment });
  const refunds = order.cases.flatMap(({ refundConfirmedAt, refundAmountMinor }) =>
    refundConfirmedAt && refundAmountMinor && refundAmountMinor > 0 ? [{ label: date(refundConfirmedAt), minor: refundAmountMinor }] : []);
  const confirmedTotal = refunds.reduce((sum, refund) => sum + refund.minor, 0);

  const details = [
    { label: "Ordered on", value: date(order.createdAt) },
    { label: "Order status", value: customerOrderStatus(order, "en") },
    ...(payment ? [
      { label: "Payment method", value: customerPaymentMethod(payment.method, "en") },
      { label: "Payment status", value: customerPaymentStatus(payment.status, "en") },
    ] : [{ label: "Payment status", value: "Unavailable" }]),
  ];
  if (isReceipt && payment?.collectedAt) {
    details.push({ label: "Payment confirmed on", value: date(payment.collectedAt) });
  }

  return {
    kind, reference: order.reference, details,
    title: isReceipt ? "Payment receipt" : "Order summary",
    items: order.items.map(item => ({ title: item.productName, detail: [item.variantName, item.sku].filter(Boolean).join(" · "),
      quantity: item.quantity, minor: item.lineTotalMinor })),
    breakdown: [
      { label: "Subtotal", minor: order.subtotalMinor },
      ...(order.discountMinor > 0 ? [{ label: "Discount", minor: -order.discountMinor }] : []),
      { label: "Delivery", minor: order.deliveryMinor },
      ...(order.taxMinor > 0 ? [{ label: "Tax", minor: order.taxMinor }] : []),
    ],
    total: { label: "Order total", minor: order.totalMinor },
    payment: isReceipt && payment ? [{ label: "Payment received", minor: payment.amountMinor }]
      : due === null ? [] : [{ label: "Amount due on delivery", minor: due }],
    refunds,
    netPaid: isReceipt && payment && confirmedTotal > 0 && confirmedTotal <= payment.amountMinor
      ? { label: "Paid after confirmed refunds", minor: payment.amountMinor - confirmedTotal } : undefined,
  };
}

export function earlierBangladeshOrderDocument(order: LegacyOrder): BangladeshOrderDocument {
  return {
    kind: "order-summary", reference: order.reference,
    title: order.kind === "preorder" ? "Pre-order summary" : "Order summary",
    details: [
      { label: "Ordered on", value: customerOrderDate(new Date(order.createdAt), "bd", "en") },
      { label: "Recorded status", value: order.statusLabel },
      ...(order.paymentLabel ? [{ label: "Recorded payment status", value: order.paymentLabel }] : []),
    ],
    items: order.items.map(item => ({ title: item.name, detail: item.sku ?? "", quantity: item.quantity })),
    breakdown: [],
    total: order.amountMinor === null ? undefined : { label: "Recorded order total", minor: order.amountMinor },
    payment: [], refunds: [],
    note: "This summary shows the information available for this earlier purchase.",
  };
}
