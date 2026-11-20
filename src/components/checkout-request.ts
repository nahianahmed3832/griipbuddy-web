import type { Market } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { MAX_QUANTITY, validCartOfferId, validVariantId } from "@/lib/cart/model";
import { measurementCheckoutHeaders } from "@/lib/measurement/browser";

export const checkoutFailures = ["invalid", "unavailable", "conflict", "error"] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function purchasedLine(value: unknown) {
  return record(value) && validVariantId(value.variantId) && typeof value.quantity === "number" &&
    Number.isInteger(value.quantity) && value.quantity > 0 && value.quantity <= MAX_QUANTITY &&
    (value.offerId === undefined || validCartOfferId(value.offerId)) &&
    (value.cartOfferId === undefined || validCartOfferId(value.cartOfferId)) &&
    (value.cartVariantId === undefined || validVariantId(value.cartVariantId)) &&
    (value.personalization === undefined || typeof value.personalization === "string");
}

export function sandboxApprovalUrl(value: unknown, origin: string) {
  if (typeof value !== "string") throw new Error("Checkout response has no approval URL");
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password) throw new Error("Unexpected payment approval URL");
  return url.href;
}

export async function postCheckout<T extends { kind: string }>(
  market: Market,
  path: "/api/checkout" | "/api/checkout/prepaid" | "/api/checkout/paypal",
  body: object,
  outcomes: readonly T["kind"][],
): Promise<T> {
  const response = await fetch(storefrontPath(path), {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-griipbuddy-checkout-market": market.id, ...measurementCheckoutHeaders() },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(45_000),
    body: JSON.stringify(body),
  });
  const result: unknown = await response.json();
  if (!record(result) || typeof result.kind !== "string" || !outcomes.includes(result.kind) ||
      (response.status >= 500 || response.status === 429) && result.kind !== "error") {
    throw new Error("Unexpected checkout response");
  }
  const { kind } = result;
  const failed = checkoutFailures.some(failure => failure === kind);
  if (kind === "changed" ? response.status !== 409 : !failed && !response.ok) {
    throw new Error("Unexpected checkout response status");
  }
  if (kind === "placed") {
    if (!validCartOfferId(result.orderId) || !Array.isArray(result.purchased) ||
        !result.purchased.length || !result.purchased.every(purchasedLine)) throw new Error("Incomplete order outcome");
  } else if (kind === "review" || kind === "changed" || kind === "quoted") {
    const quote = result.quote;
    const token = record(quote) && quote[kind === "quoted" ? "quoteToken" : "reviewToken"];
    const tokenFormat = kind === "quoted" ? /^\d{13}\.[a-f0-9]{64}$/ : /^[a-f0-9]{64}$/;
    if (!record(quote) || quote.currency !== market.currency || !Array.isArray(quote.lines) ||
        typeof quote.totalMinor !== "number" || !Number.isSafeInteger(quote.totalMinor) || quote.totalMinor < 0 ||
        typeof token !== "string" || !tokenFormat.test(token) || kind === "review" && !validCartOfferId(result.attemptId)) {
      throw new Error("Incomplete checkout review");
    }
  } else if (failed || kind === "pending" || result.message !== undefined) {
    if (typeof result.message !== "string") throw new Error("Incomplete checkout status");
  }
  if (result.issues !== undefined && (!Array.isArray(result.issues) || result.issues.some(issue => typeof issue !== "string"))) {
    throw new Error("Unexpected checkout validation message");
  }
  return result as T;
}
