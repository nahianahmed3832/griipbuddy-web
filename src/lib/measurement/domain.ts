import { createHash } from "node:crypto";
import type { CurrencyCode, FulfillmentStatus, MarketCode, MeasurementKind, PaymentMethod, PaymentStatus } from "../../generated/prisma/client.ts";
import { campaignLabel } from "./campaign.ts";

export const journeyDays = 7;
export const journeySeconds = journeyDays * 86_400;
export const measurementRetentionDays = 30;
const dayMs = 86_400_000;

export function stableMeasurementId(...values: string[]) {
  return createHash("sha256").update(JSON.stringify(["griipbuddy-acquisition-v1", ...values])).digest("hex");
}

export type Observation = {
  id: string; kind: MeasurementKind; at: Date; variantId: string | null; campaign: string | null;
};

export type CommerceMeasurementRow = {
  id: string;
  createdAt: Date;
  cancelledAt: Date | null;
  marketId: MarketCode;
  currency: CurrencyCode;
  measurementTest: boolean | null;
  fulfillmentStatus: FulfillmentStatus;
  totalMinor: number; subtotalMinor: number; discountMinor: number; taxMinor: number; deliveryMinor: number;
  items: {
    variantId: string; quantity: number; unitPriceMinor: number; unitDiscountMinor: number;
  }[];
  payment: { method: PaymentMethod; status: PaymentStatus; currency: CurrencyCode; amountMinor: number; collectedAt: Date | null } | null;
};

export function withinJourney(from: Date, through: Date) {
  return +through >= +from && +through - +from < journeyDays * dayMs;
}

export function cohort(events: Observation[]) {
  const product = events.find(event => event.kind === "PRODUCT_VIEW");
  if (!product) return null;
  const cart = events.find(event => event.kind === "CART_ADD" && withinJourney(product.at, event.at));
  const checkout = cart && events.find(event => event.kind === "CHECKOUT_START" && withinJourney(product.at, event.at) && +event.at >= +cart.at);
  return { product, cart, checkout };
}

export function eligiblePath(events: Observation[], order: CommerceMeasurementRow) {
  const path = cohort(events);
  if (!path?.checkout || !withinJourney(path.product.at, order.createdAt)) return null;
  const variants = new Set(order.items.map(item => item.variantId));
  // Count any measured cart addition present in the saved order, after the
  // first observed view and before any checkout that preceded this order.
  const latestCheckout = events.reduce<Observation | undefined>((latest, event) =>
    event.kind === "CHECKOUT_START" && +event.at <= +order.createdAt ? event : latest, undefined);
  return latestCheckout && events.some(event => event.kind === "CART_ADD" && event.variantId && variants.has(event.variantId) &&
    +event.at >= +path.product.at && +event.at <= +latestCheckout.at) ? path : null;
}

export function projectedOrderEvents(order: CommerceMeasurementRow, cutoff: Date) {
  if (+order.createdAt > +cutoff) return [];
  const transactionId = `gb-${stableMeasurementId("transaction", order.id).slice(0, 40)}`;
  const event = (kind: "ORDER_ACCEPTED" | "ORDER_CANCELLED" | "COD_COLLECTED", at: Date, amountMinor: number | null) => ({
    id: stableMeasurementId(kind, order.id), kind, transactionId, at, currency: order.currency, amountMinor,
  });
  const events = [event("ORDER_ACCEPTED", order.createdAt, order.totalMinor)];
  if (order.cancelledAt && +order.cancelledAt <= +cutoff && +order.cancelledAt >= +order.createdAt) {
    events.push(event("ORDER_CANCELLED", order.cancelledAt, null));
  }
  const payment = order.payment;
  if (payment?.method === "COD" && payment.status === "COLLECTED" && payment.collectedAt &&
      payment.currency === order.currency && payment.amountMinor > 0 && +payment.collectedAt >= +order.createdAt && +payment.collectedAt <= +cutoff) {
    events.push(event("COD_COLLECTED", payment.collectedAt, payment.amountMinor));
  }
  return events;
}

export function majorUnits(amountMinor: number, currency: CurrencyCode) {
  // The sales database currently supports these two ISO currencies, both with two decimals.
  if ((currency !== "BDT" && currency !== "USD") || !Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error("Invalid analytics amount");
  }
  return amountMinor / 100;
}

export const ga4BrowserNames = {
  PRODUCT_VIEW: "view_item", CART_ADD: "add_to_cart", CHECKOUT_START: "begin_checkout",
} as const;

// Schema preview only. No external sender is enabled. Do not call for unmatched or unconsented orders.
export function ga4BookedOrder(order: CommerceMeasurementRow, cutoff: Date, allowTestPreview = false) {
  if ((!allowTestPreview && order.measurementTest !== false) || order.payment?.method !== "COD") return null;
  const accepted = projectedOrderEvents(order, cutoff)[0];
  if (!accepted) return null;
  return {
    name: "purchase" as const,
    params: {
      transaction_id: accepted.transactionId,
      currency: order.currency,
      value: majorUnits(order.subtotalMinor - order.discountMinor, order.currency),
      shipping: majorUnits(order.deliveryMinor, order.currency),
      tax: majorUnits(order.taxMinor, order.currency),
      payment_type: "COD",
      items: order.items.map(item => ({
        item_id: item.variantId,
        price: majorUnits(item.unitPriceMinor - item.unitDiscountMinor, order.currency),
        discount: majorUnits(item.unitDiscountMinor, order.currency),
        quantity: item.quantity,
      })),
    },
  };
}

export function dateInDhaka(date: Date) {
  // Dhaka is UTC+6; timeZone makes the calendar boundary explicit.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dhaka", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function cohortWindow(now: Date, start?: string, end?: string) {
  const actualDay = dateInDhaka(now);
  const parse = (value: string | undefined) => {
    if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(value + "T00:00:00+06:00");
    return !Number.isNaN(+date) && dateInDhaka(date) === value ? date : null;
  };
  const defaultStartDay = dateInDhaka(new Date(+now - 6 * dayMs));
  const oldest = dateInDhaka(new Date(+now - (measurementRetentionDays - 1) * dayMs));
  const to = parse(end) && end! >= oldest && end! <= actualDay ? end! : actualDay;
  const toAt = parse(to)!;
  const from = parse(start) && start! >= oldest && start! <= to && +toAt - +parse(start)! < 7 * dayMs
    ? start! : (to === actualDay ? defaultStartDay : to);
  return { from, to, fromAt: parse(from)!, until: new Date(Math.min(+now, +toAt + dayMs)) };
}

export function vettedCampaign(input: Record<string, unknown> | undefined, isSelectedLanding: boolean) {
  return isSelectedLanding ? campaignLabel(input) : null;
}
