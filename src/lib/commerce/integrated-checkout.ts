import { randomUUID } from "node:crypto";
import { getDb } from "../db/client.ts";
import { localDatabase, stagingDatabase } from "../db/local.ts";
import { markets, type MarketId } from "../../config/markets.ts";
import { validVariantId } from "../cart/model.ts";
import {
  checkoutInput, submissionInput, uuid, type CheckoutQuote, type NormalizedCheckout, type OrderPlaced, type RecoverResult,
  type DeliveryChoice, type ReviewResult, type SubmitResult,
} from "./checkout-types.ts";
import { requestDigest, quoteDigest, equalDigest } from "./guest.ts";

type Line = { productId: string; variantId: string; quantity: number; unit: number; regular: number; discountMinor: number;
  sku: string; title: string; attributes?: Record<string, string> };
type Quote = { cartRevision: number; quoteRevision: string; checkoutReady: boolean;
  review: { currency: string; total: number; shipping: number; tax: number; coupon: number }; lines: Line[] };
type ServerCart = { id: string; revision: number };
type ReceiptOrder = { id: string; number: string; attempt: string; currency: "BDT"; status: string; payment: string; createdAt: string;
  fulfillment: "UNFULFILLED" | "PACKING" | "READY_TO_SHIP" | "SHIPPED" | "DELIVERED"; total: number; paid: number; tracking?: string;
  destination: { name: string; phone: string; address: string; city: string; state: string; postal?: string };
  original: { merchandiseMinor: number; discountMinor: number; shippingMinor: number; taxMinor: number; totalMinor: number;
    lines: { variantId: string; sku: string; title: string; quantity: number; unitMinor: number; discountMinor: number;
      attributes?: Record<string, string> }[] } };

export function integratedCheckout() {
  if (process.env.COMMERCE_MODE === "staging" && process.env.GRIIP_HOSTINGER_PILOT === "1") {
    if (!stagingDatabase()) throw new Error("Pilot checkout requires its dedicated staging database.");
    return "http://pilot-api:38100";
  }
  const origin = process.env.GRIIP_RECOVERED_CHECKOUT;
  return localDatabase() === "griipbuddy_test" && /^http:\/\/127\.0\.0\.1:38\d{3}$/.test(origin ?? "") ? origin : null;
}

export class RecoveredCheckoutError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function recoveredRequest<T>(path: string, token?: string, method = "GET", body?: unknown): Promise<T> {
  const origin = integratedCheckout();
  if (!origin) throw new Error("The isolated recovered checkout is unavailable.");
  const response = await fetch(origin + "/api/v1" + path, {
    method, headers: { ...(token && { "x-cart-token": token }), ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12_000),
  });
  const value = await response.json();
  if (!response.ok || value.success !== true) throw new RecoveredCheckoutError(response.status, value.message ?? "Checkout is unavailable.");
  return value.data;
}

export async function recoveredDeliveryChoices(market: MarketId): Promise<DeliveryChoice[]> {
  if (market !== "bd") return [];
  const terms = await recoveredRequest<{ shippingMinor: number; methods: string[] }>("/commerce/market/BD");
  return terms.methods.includes("cod") ? [{ district: "dhaka", districtLabel: "Dhaka", method: "standard",
    label: "Standard delivery", chargeMinor: terms.shippingMinor, guidance: null }] : [];
}

function delivery(input: NormalizedCheckout) {
  const district = input.customer.district;
  return { country: "BD", name: input.customer.name, phone: input.customer.phone,
    ...(input.customer.email && { email: input.customer.email }), street: input.customer.address, city: input.customer.locality,
    region: district[0].toUpperCase() + district.slice(1), ...(input.customer.postalCode && { postal: input.customer.postalCode }) };
}

function publicQuote(data: Quote, token: string, attempt: string, input: NormalizedCheckout): CheckoutQuote {
  if (data.review.currency !== markets.bd.currency || !data.checkoutReady) throw new RecoveredCheckoutError(422, "Review the available checkout terms.");
  const { total, shipping, tax, coupon } = data.review;
  return { currency: "BDT", lines: data.lines.map(line => ({
    variantId: "v-" + line.variantId, productName: line.title, variantName: Object.values(line.attributes ?? {}).join(" / "),
    sku: line.sku, quantity: line.quantity, unitPriceMinor: line.regular,
    unitDiscountMinor: line.regular - line.unit, lineTotalMinor: line.unit * line.quantity - line.discountMinor,
  })), districtLabel: delivery(input).region, deliveryLabel: "Standard delivery", deliveryGuidance: null,
    subtotalMinor: data.lines.reduce((sum, line) => sum + line.regular * line.quantity, 0),
    discountMinor: coupon + data.lines.reduce((sum, line) => sum + (line.regular - line.unit) * line.quantity, 0),
    deliveryMinor: shipping, taxMinor: tax, taxLabel: "Tax (trial)", totalMinor: total,
    reviewToken: quoteDigest(JSON.stringify([token, attempt, data.cartRevision, data.quoteRevision])) };
}

function errorResult(error: unknown) {
  if (!(error instanceof RecoveredCheckoutError) || error.status >= 500 && error.status !== 503) throw error;
  return { kind: "unavailable" as const, message: error.message };
}

function conflict() {
  return { kind: "conflict" as const, message: "This checkout attempt cannot be reused. Check your order or review your cart." };
}

function placed(order: ReceiptOrder): OrderPlaced {
  return { kind: "placed", orderId: order.attempt,
    purchased: order.original.lines.map(line => ({ variantId: "v-" + line.variantId, quantity: line.quantity })) };
}

async function attemptOrder(attempt: string, token: string) {
  try { return await recoveredRequest<ReceiptOrder>("/checkout/cod-orders/attempts/" + attempt, token); }
  catch (error) { if (!(error instanceof RecoveredCheckoutError) || error.status !== 404) throw error; return null; }
}

const isMongoVariant = (value: string) => validVariantId(value) && /^v-[a-f0-9]{24}$/.test(value);
function canonical(input: NormalizedCheckout) {
  const { marketId, items, customer, deliveryMethod, paymentMethod } = input;
  return { marketId, items: [...items].sort((a, b) => a.variantId.localeCompare(b.variantId)), customer, deliveryMethod, paymentMethod };
}

export async function reviewRecovered(raw: unknown, market: MarketId, guestKey: string): Promise<ReviewResult> {
  const parsed = checkoutInput.strict().safeParse(raw);
  if (!parsed.success || market !== "bd" || parsed.data.marketId !== market || parsed.data.deliveryMethod !== "standard" ||
      !parsed.data.items.every(row => isMongoVariant(row.variantId) && !row.personalization)) return { kind: "invalid", message: "Review the Bangladesh address and cart." };
  const input = canonical(parsed.data);
  try {
    const db = getDb();
    const variants = await db.variant.findMany({ where: { id: { in: input.items.map(row => row.variantId) } }, select: { id: true, productId: true } });
    const products = new Map(variants.map(row => [row.id, row.productId.slice(2)]));
    const lines = input.items.map(row => ({ variant: row.variantId.slice(2), product: products.get(row.variantId), quantity: row.quantity }));
    if (lines.some(line => !/^[a-f0-9]{24}$/.test(line.product ?? ""))) return { kind: "invalid", message: "A cart item is no longer listed." };
    const { token, cart } = await recoveredRequest<{ token: string; cart: ServerCart }>("/checkout/cart", undefined, "POST", { market: "BD" });
    const updated = await recoveredRequest<{ cart: ServerCart }>("/checkout/cart", token, "PUT",
      { cartId: cart.id, revision: cart.revision, market: "BD", lines, coupons: [] });
    const address = delivery(input);
    const quote = await recoveredRequest<Quote>("/checkout/quote", token, "POST",
      { cartId: cart.id, revision: updated.cart.revision, delivery: address });
    const attempt = await db.checkoutAttempt.create({ data: { id: randomUUID(), guestKey,
      requestHash: requestDigest(JSON.stringify(input)), recoveredCart: { id: cart.id, revision: updated.cart.revision, token } } });
    return { kind: "review", attemptId: attempt.id, quote: publicQuote(quote, token, attempt.id, input) };
  } catch (error) { return errorResult(error); }
}

function recoveredCart(value: unknown) {
  if (!value || typeof value !== "object" || !("id" in value) || !("revision" in value) || !("token" in value) ||
      typeof value.id !== "string" || typeof value.revision !== "number" || typeof value.token !== "string") return null;
  return { cartId: value.id, revision: value.revision, token: value.token };
}

export async function submitRecovered(raw: unknown, market: MarketId, guestKey: string): Promise<SubmitResult> {
  const parsed = submissionInput.strict().safeParse(raw);
  if (!parsed.success || market !== "bd" || parsed.data.marketId !== market || parsed.data.items.some(row => row.personalization)) {
    return { kind: "invalid", message: "Review the Bangladesh order details." };
  }
  const { attemptId, reviewToken } = parsed.data;
  const input = canonical(parsed.data);
  const attempt = await getDb().checkoutAttempt.findFirst({ where: { id: attemptId, guestKey, abandonedAt: null } });
  const cart = recoveredCart(attempt?.recoveredCart);
  if (!attempt || !cart || attempt.requestHash !== requestDigest(JSON.stringify(input))) return conflict();
  const previous = await attemptOrder(attemptId, cart.token);
  if (previous) return placed(previous);
  try {
    const { token, ...ref } = cart;
    const details = { ...ref, delivery: delivery(input) };
    const latest = await recoveredRequest<Quote>("/checkout/quote", token, "POST", details);
    const quote = publicQuote(latest, token, attemptId, input);
    if (!equalDigest(quote.reviewToken, reviewToken)) return { kind: "changed", quote };
    const result = await recoveredRequest<ReceiptOrder>("/checkout/cod-orders", token, "POST",
      { ...details, key: attemptId, quoteRevision: latest.quoteRevision });
    return placed(result);
  } catch (error) {
    if (error instanceof RecoveredCheckoutError && error.status === 409) {
      const accepted = await attemptOrder(attemptId, cart.token);
      if (accepted) return placed(accepted);
    }
    return errorResult(error);
  }
}

export async function recoverRecovered(value: unknown, guestKey: string): Promise<RecoverResult> {
  const parsed = uuid.safeParse(value);
  if (!parsed.success) return conflict();
  const attempt = await getDb().checkoutAttempt.findFirst({ where: { id: parsed.data, guestKey } });
  const cart = recoveredCart(attempt?.recoveredCart);
  if (!cart) return conflict();
  try {
    const { token, ...ref } = cart;
    const order = await recoveredRequest<ReceiptOrder | null>("/checkout/cod-orders/attempts/" + parsed.data + "/abandon", token, "POST", ref);
    if (order) return placed(order);
    await getDb().checkoutAttempt.updateMany({ where: { id: parsed.data, guestKey, abandonedAt: null }, data: { abandonedAt: new Date() } });
    return { kind: "abandoned" };
  } catch (error) { return errorResult(error); }
}

export async function readRecoveredOrder(id: string, guestKey: string) {
  if (!uuid.safeParse(id).success) return null;
  const attempt = await getDb().checkoutAttempt.findFirst({ where: { id, guestKey }, select: { recoveredCart: true } });
  const cart = recoveredCart(attempt?.recoveredCart);
  return cart ? attemptOrder(id, cart.token) : null;
}

export async function listRecoveredOrders(guestKey: string) {
  const attempts = await getDb().checkoutAttempt.findMany({ where: { guestKey, abandonedAt: null }, orderBy: { createdAt: "desc" }, take: 30,
    select: { id: true, recoveredCart: true } });
  const orders = await Promise.all(attempts.map(attempt => {
    const cart = recoveredCart(attempt.recoveredCart);
    return cart ? attemptOrder(attempt.id, cart.token) : null;
  }));
  return orders.filter(order => order !== null).map(order => ({ id: order.attempt, reference: order.number,
    status: order.status === "cancelled" ? "CANCELLED" as const : "PLACED" as const,
    fulfillmentStatus: order.fulfillment, createdAt: new Date(order.createdAt) }));
}

export async function recoveredStock<T extends { offer: { stock: number } | null }>(row: T, productId: string, variantId: string): Promise<T> {
  if (!integratedCheckout() || !row.offer) return row;
  if (!/^p-[a-f0-9]{24}$/.test(productId) || !isMongoVariant(variantId)) return { ...row, offer: { ...row.offer, stock: 0 } };
  try {
    const availability = await recoveredRequest<{ totalAvailableQuantity: number }>("/stocks/" + productId.slice(2) + "/" + variantId.slice(2));
    return { ...row, offer: { ...row.offer, stock: availability.totalAvailableQuantity } };
  } catch {
    return { ...row, offer: { ...row.offer, stock: 0 } };
  }
}
