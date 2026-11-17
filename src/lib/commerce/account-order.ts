import type { Currency, MarketId } from "../../config/markets.ts";
import { formatMoney, marketIds, marketLocale, markets } from "../../config/markets.ts";
import type { BangladeshShipmentStatus, FulfillmentStatus, OrderStatus, PaymentMethod, PaymentStatus } from "../../generated/prisma/enums.ts";
import { accountText, type AccountLanguage } from "../marketplace/account-language.ts";
import { bangladeshTrackingLabels } from "./bangladesh-shipment-status.ts";
import { fulfillmentLabels, orderLabels, paymentLabels, paymentMethodLabels } from "./labels.ts";

type OrderProgress = {
  status: OrderStatus;
  fulfillmentStatus: FulfillmentStatus;
  bangladeshShipment?: { status: BangladeshShipmentStatus } | null;
  bangladeshRefusedParcelReceipt?: { receivedAt: Date } | null;
};

type CashBalance = {
  status: OrderStatus;
  marketId: MarketId;
  currency: Currency;
  payment: { status: PaymentStatus; method: PaymentMethod; amountMinor: number; currency: Currency } | null;
};

export function cashDueOnDelivery({ status, marketId, currency, payment }: CashBalance) {
  if (marketId !== "bd" || status !== "PLACED" || currency !== "BDT" || payment?.currency !== currency ||
      payment.method !== "COD" || payment.status !== "AWAITING_COLLECTION") return null;
  return payment.amountMinor;
}

const fulfillmentBn = {
  UNFULFILLED: "প্রস্তুতির অপেক্ষায়", PACKING: "প্যাক করা হচ্ছে", READY_TO_SHIP: "পাঠানোর জন্য প্রস্তুত", SHIPPED: "পাঠানো হয়েছে", DELIVERED: "ডেলিভারি সম্পন্ন",
} satisfies Record<FulfillmentStatus, string>;
const shipmentBn = {
  IN_TRANSIT: "পথে আছে", OUT_FOR_DELIVERY: "ডেলিভারির জন্য বের হয়েছে", DELIVERED: "ডেলিভারি সম্পন্ন", REFUSED: "ডেলিভারি গ্রহণ করা হয়নি",
} satisfies Record<BangladeshShipmentStatus, string>;
const paymentBn = {
  AWAITING_COLLECTION: "পেমেন্ট বাকি", COLLECTED: "টাকা গ্রহণ করা হয়েছে", VOIDED: "পেমেন্ট বাতিল",
  PAID: "পেমেন্ট সম্পন্ন", REFUND_PENDING: "টাকা ফেরতের অপেক্ষায়", REFUNDED: "টাকা ফেরত দেওয়া হয়েছে",
  AWAITING_VERIFICATION: "পেমেন্ট যাচাইয়ের অপেক্ষায়",
} satisfies Record<PaymentStatus, string>;

export function customerOrderState(status: OrderStatus, language: AccountLanguage) {
  return accountText(language, orderLabels[status], status === "CANCELLED" ? "বাতিল হয়েছে" : "অর্ডার করা হয়েছে");
}

export function customerShipmentStatus(status: BangladeshShipmentStatus, language: AccountLanguage) {
  return accountText(language, bangladeshTrackingLabels[status], shipmentBn[status]);
}

export function customerOrderStatus(order: OrderProgress, language: AccountLanguage) {
  if (order.status === "CANCELLED") return customerOrderState(order.status, language);
  if (order.bangladeshRefusedParcelReceipt) return accountText(language, "Returned to GriipBuddy", "GriipBuddy-তে ফেরত এসেছে");
  return order.bangladeshShipment
    ? customerShipmentStatus(order.bangladeshShipment.status, language)
    : accountText(language, fulfillmentLabels[order.fulfillmentStatus], fulfillmentBn[order.fulfillmentStatus]);
}

export function customerPaymentStatus(status: PaymentStatus, language: AccountLanguage) {
  return accountText(language, paymentLabels[status], paymentBn[status]);
}

export function customerPaymentMethod(method: PaymentMethod, language: AccountLanguage) {
  return method === "COD" ? accountText(language, paymentMethodLabels.COD, "ক্যাশ অন ডেলিভারি") : paymentMethodLabels[method];
}

export function customerOrderMoney(amount: number, currency: Currency, language: AccountLanguage) {
  if (currency === "BDT" && language === "bn") {
    return new Intl.NumberFormat("bn-BD", {
      style: "currency", currency, currencyDisplay: "narrowSymbol", minimumFractionDigits: amount % 100 === 0 ? 0 : 2, maximumFractionDigits: 2,
    }).format(amount / 100);
  }
  const market = marketIds.find(id => markets[id].currency === currency);
  return formatMoney(amount, markets[market ?? "bd"]);
}

export function customerOrderDate(date: Date, market: MarketId, language: AccountLanguage, withTime = false) {
  return new Intl.DateTimeFormat(marketLocale(market, language), {
    dateStyle: "medium", ...(withTime && { timeStyle: "short" }), timeZone: markets[market].timeZone,
  }).format(date);
}
