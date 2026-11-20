import { createHash } from "node:crypto";
import type { CurrencyCode, FulfillmentStatus, MarketCode, MeasurementKind, PaymentMethod, PaymentStatus } from "../../generated/prisma/client.ts";
import { campaignLabel } from "./campaign.ts";
import { defaultMarketId, marketList } from "../../config/markets.ts";
import { marketConfiguration } from "../market-config.ts";
import { marketDay, marketDayStart, shiftCalendarDay } from "../market-calendar.ts";

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

export function eligiblePath(events: Observation[], order: { createdAt: Date; items: readonly { variantId: string }[] }) {
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
  const minorDigits = marketList.find(market => market.currency === currency)?.minorDigits;
  if (minorDigits === undefined || !Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new Error("Invalid analytics amount");
  }
  return amountMinor / 10 ** minorDigits;
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

export function cohortWindow(now: Date, start?: string, end?: string, timeZone = marketConfiguration(defaultMarketId).timeZone) {
  const actualDay = marketDay(now, timeZone);
  const oldest = shiftCalendarDay(actualDay, 1 - measurementRetentionDays)!;
  const to = end && end >= oldest && end <= actualDay && marketDayStart(end, timeZone) ? end : actualDay;
  const earliest = shiftCalendarDay(to, -6)!;
  const from = start && start >= earliest && start >= oldest && start <= to && marketDayStart(start, timeZone)
    ? start : to === actualDay ? earliest : to;
  const through = shiftCalendarDay(to, 1)!;
  const until = marketDayStart(through, timeZone) ?? marketDayStart(shiftCalendarDay(through, 1)!, timeZone)!;
  return { from, to, fromAt: marketDayStart(from, timeZone)!, until: new Date(Math.min(+now, +until)) };
}

export function vettedCampaign(input: Record<string, unknown> | undefined, isSelectedLanding: boolean) {
  return isSelectedLanding ? campaignLabel(input) : null;
}
