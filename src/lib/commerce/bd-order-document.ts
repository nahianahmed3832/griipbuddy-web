import type { CurrencyCode, PaymentStatus, Prisma } from "../../generated/prisma/client.ts";
import { accountText, type AccountLanguage } from "../marketplace/account-language.ts";
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
  language: AccountLanguage;
  details: DocumentField[];
  items: DocumentItem[];
  breakdown: DocumentAmount[];
  total?: DocumentAmount;
  payment: DocumentAmount[];
  refunds: DocumentAmount[];
  netPaid?: DocumentAmount;
  note?: string;
};

export function nativeBangladeshOrderDocument(order: NativeDocumentOrder, language: AccountLanguage): BangladeshOrderDocument {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const date = (value: Date) => customerOrderDate(value, "bd", language);
  const payment = order.payment?.currency === "BDT" ? order.payment : null;
  const kind = bangladeshOrderDocumentKind(payment);
  const isReceipt = kind === "payment-receipt";
  const due = cashDueOnDelivery({ ...order, payment });
  const refunds = order.cases.flatMap(({ refundConfirmedAt, refundAmountMinor }) =>
    refundConfirmedAt && refundAmountMinor && refundAmountMinor > 0 ? [{ label: date(refundConfirmedAt), minor: refundAmountMinor }] : []);
  const confirmedTotal = refunds.reduce((sum, refund) => sum + refund.minor, 0);

  const details = [
    { label: t("Ordered on", "অর্ডারের তারিখ"), value: date(order.createdAt) },
    { label: t("Order status", "অর্ডারের অবস্থা"), value: customerOrderStatus(order, language) },
    ...(payment ? [
      { label: t("Payment method", "পেমেন্ট পদ্ধতি"), value: customerPaymentMethod(payment.method, language) },
      { label: t("Payment status", "পেমেন্টের অবস্থা"), value: customerPaymentStatus(payment.status, language) },
    ] : [{ label: t("Payment status", "পেমেন্টের অবস্থা"), value: t("Unavailable", "পাওয়া যায়নি") }]),
  ];
  if (isReceipt && payment?.collectedAt) {
    details.push({ label: t("Payment confirmed on", "পেমেন্ট নিশ্চিতের তারিখ"), value: date(payment.collectedAt) });
  }

  return {
    kind, language, reference: order.reference, details,
    title: isReceipt ? t("Payment receipt", "পেমেন্ট রসিদ") : t("Order summary", "অর্ডারের সারাংশ"),
    items: order.items.map(item => ({ title: item.productName, detail: [item.variantName, item.sku].filter(Boolean).join(" · "),
      quantity: item.quantity, minor: item.lineTotalMinor })),
    breakdown: [
      { label: t("Subtotal", "পণ্যের উপমোট"), minor: order.subtotalMinor },
      ...(order.discountMinor > 0 ? [{ label: t("Discount", "ছাড়"), minor: -order.discountMinor }] : []),
      { label: t("Delivery", "ডেলিভারি"), minor: order.deliveryMinor },
      ...(order.taxMinor > 0 ? [{ label: t("Tax", "কর"), minor: order.taxMinor }] : []),
    ],
    total: { label: t("Order total", "অর্ডারের মোট"), minor: order.totalMinor },
    payment: isReceipt && payment ? [{ label: t("Payment received", "প্রাপ্ত পেমেন্ট"), minor: payment.amountMinor }]
      : due === null ? [] : [{ label: t("Amount due on delivery", "ডেলিভারির সময় পরিশোধযোগ্য"), minor: due }],
    refunds,
    netPaid: isReceipt && payment && confirmedTotal > 0 && confirmedTotal <= payment.amountMinor
      ? { label: t("Paid after confirmed refunds", "নিশ্চিত ফেরতের পর পরিশোধিত টাকা"), minor: payment.amountMinor - confirmedTotal } : undefined,
  };
}

export function earlierBangladeshOrderDocument(order: LegacyOrder, language: AccountLanguage): BangladeshOrderDocument {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  return {
    kind: "order-summary", language, reference: order.reference,
    title: order.kind === "preorder" ? t("Pre-order summary", "প্রি-অর্ডারের সারাংশ") : t("Order summary", "অর্ডারের সারাংশ"),
    details: [
      { label: t("Ordered on", "অর্ডারের তারিখ"), value: customerOrderDate(new Date(order.createdAt), "bd", language) },
      { label: t("Recorded status", "সংরক্ষিত অবস্থা"), value: order.statusLabel },
      ...(order.paymentLabel ? [{ label: t("Recorded payment status", "সংরক্ষিত পেমেন্টের অবস্থা"), value: order.paymentLabel }] : []),
    ],
    items: order.items.map(item => ({ title: item.name, detail: item.sku ?? "", quantity: item.quantity })),
    breakdown: [],
    total: order.amountMinor === null ? undefined : { label: t("Recorded order total", "অর্ডারের সংরক্ষিত মোট"), minor: order.amountMinor },
    payment: [], refunds: [],
    note: t("This summary shows the information available for this earlier purchase.", "এই সারাংশে আগের কেনাকাটার সংরক্ষিত তথ্য রয়েছে।"),
  };
}
