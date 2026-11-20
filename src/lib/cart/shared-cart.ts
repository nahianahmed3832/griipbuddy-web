import { createHash } from "node:crypto";
import type { MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import type { CheckoutCartContext } from "../commerce/checkout-types.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { resolveMarketScope } from "../market-config.ts";
import { addToItems, cartItemKey, compareCartItems, decodeCart, MAX_QUANTITY, purchasedCartItem,
  type CartItem, type CheckoutCartItem } from "./model.ts";
import { readQuantityLots, subtractPurchasedQuantities, updateQuantityLots } from "./quantity-lots.ts";
import type { CartSyncRequest, CartSyncSnapshot } from "./sync-contract.ts";
import { applyLineChange, capacityMessage, staleMessage, type CartLines } from "./line-mutations.ts";

type Mutation = Exclude<CartSyncRequest, { mode: "read" }>;
type SyncResult = { status: 200; body: CartSyncSnapshot }
  | { status: 409; body: CartSyncSnapshot & { message: string } }
  | { status: 403 | 404; body: { message: string } };

const cartFields = { revision: true, items: true, saved: true, lots: true } satisfies Prisma.ShopperMarketCartSelect;

function snapshot(shopperId: string, marketId: MarketId,
  row: { revision: number; items: Prisma.JsonValue; saved: Prisma.JsonValue } | null): CartSyncSnapshot {
  return {
    shopperId, marketId, revision: row?.revision ?? 0,
    items: row ? decodeCart(JSON.stringify(row.items)) : [], saved: row ? decodeCart(JSON.stringify(row.saved)) : [],
  };
}

export async function checkoutCartMatches(shopperId: string, marketId: MarketId, cart: CheckoutCartContext | undefined,
  items: readonly CheckoutCartItem[], reader: DbReader = getDb(), lock = false) {
  if (cart?.source !== "cart") return true;
  if (lock) await reader.$queryRaw`SELECT "shopperId" FROM "ShopperMarketCart"
    WHERE "shopperId" = ${shopperId} AND "marketId" = ${marketId}::"MarketCode" FOR SHARE`;
  const row = await reader.shopperMarketCart.findUnique({ where: { shopperId_marketId: { shopperId, marketId } },
    select: { revision: true, items: true } });
  if (!row || row.revision !== cart.revision) return false;
  const ordered = (lines: readonly CartItem[]) => [...lines].sort(compareCartItems).map(line => [cartItemKey(line), line.quantity]);
  return JSON.stringify(ordered(decodeCart(JSON.stringify(row.items)))) === JSON.stringify(ordered(items.map(purchasedCartItem)));
}

function mergeItems(items: readonly CartItem[], incoming: readonly CartItem[]) {
  let merged = items;
  for (const line of incoming) {
    const next = addToItems(merged, line.variantId, line.quantity, MAX_QUANTITY, line.personalization, line.offerId);
    if (!next) return null;
    merged = next;
  }
  return merged;
}

async function purchasedItems(shopperId: string, marketId: MarketId, orderId: string, guestKey?: string | null) {
  const db = getDb();
  const market = resolveMarketScope(marketId);
  if (!market) return null;
  const order = await db.order.findFirst({
    where: { id: orderId, shopperId, marketId, currency: market.currency, status: "PLACED", OR: [
      { payment: { method: "COD", status: { in: ["AWAITING_COLLECTION", "COLLECTED"] } } },
      { payment: { status: "PAID" } },
    ] },
    select: { attempt: { select: { cartSource: true, cartRevision: true, reviewActor: true } }, items: { select: {
      variantId: true, personalization: true, quantity: true, cartVariantIdSnapshot: true, cartOfferIdSnapshot: true,
    } } },
  });
  if (order) return {
    revision: order.attempt.cartSource === "cart" && order.attempt.reviewActor === `shopper:${shopperId}` ? order.attempt.cartRevision : null,
    items: order.items.map(({ cartVariantIdSnapshot, cartOfferIdSnapshot, ...item }) => purchasedCartItem({
      ...item, cartVariantId: cartVariantIdSnapshot ?? undefined, cartOfferId: cartOfferIdSnapshot ?? undefined,
    })),
  };
  // A recovered receipt uses the original browser proof and an explicitly
  // account-bound attempt. A late sign-in never authenticates an old guest cart.
  if (marketId !== "bd" || !guestKey) return null;
  const attempt = await db.checkoutAttempt.findFirst({
    where: { id: orderId, guestKey, marketId, reviewActor: `shopper:${shopperId}`, cartSource: "cart" },
    select: { cartRevision: true },
  });
  if (!attempt || attempt.cartRevision === null) return null;
  const { integratedCheckout, readRecoveredOrder } = await import("../commerce/integrated-checkout.ts");
  if (!integratedCheckout(marketId)) return null;
  const recovered = await readRecoveredOrder(orderId, guestKey, shopperId);
  return recovered && recovered.status !== "cancelled" ? { revision: attempt.cartRevision,
    items: recovered.original.lines.map(line => ({ variantId: `v-${line.variantId}`, quantity: line.quantity })),
  } : null;
}

function nextLines(current: CartLines, request: Mutation, stock: number): CartLines | string {
  if (request.mode === "merge") {
    const items = mergeItems(current.items, request.items);
    const saved = mergeItems(current.saved, request.saved);
    return items && saved ? { items, saved } : capacityMessage;
  }
  return request.command.type === "complete-purchase" ? current : applyLineChange(current, request.command, stock);
}

export async function syncShopperCart(shopperId: string, request: CartSyncRequest, checks?: {
  guestKey?: string | null;
  stock?: (reader: DbReader) => Promise<number | null>;
  merge?: (reader: DbReader) => Promise<boolean>;
}): Promise<SyncResult> {
  if (request.shopperId !== shopperId) return { status: 403, body: { message: "The signed-in account changed. Refresh the page." } };
  const { marketId } = request;
  if (!resolveMarketScope(marketId)) return { status: 403, body: { message: "This shopping market is unavailable." } };
  const db = getDb();
  const key = { shopperId, marketId };
  const lookup = { where: { shopperId_marketId: key }, select: cartFields };
  if (request.mode === "read") {
    return { status: 200, body: snapshot(shopperId, marketId, await db.shopperMarketCart.findUnique(lookup)) };
  }

  const orderId = request.mode === "change" && request.command.type === "complete-purchase" ? request.command.orderId : null;
  const operationId = orderId ?? request.operationId;
  const operation = { ...key, operationId, purchase: Boolean(orderId) };
  const receipt = { where: { shopperId_marketId_purchase_operationId: operation }, select: { requestHash: true } };
  const requestHash = createHash("sha256").update(JSON.stringify(orderId ? ["complete-purchase", orderId] : request)).digest("hex");
  let purchase: Awaited<ReturnType<typeof purchasedItems>> = null;
  if (orderId) {
    if (await db.shopperMarketCartOperation.findUnique(receipt)) {
      return { status: 200, body: snapshot(shopperId, marketId, await db.shopperMarketCart.findUnique(lookup)) };
    }
    purchase = await purchasedItems(shopperId, marketId, orderId, checks?.guestKey);
    if (!purchase) return { status: 404, body: { message: "That completed order was not found." } };
  }

  return db.$transaction(async tx => {
    // INSERT ON CONFLICT safely establishes the row for shoppers using two devices for the first time.
    await tx.shopperMarketCart.createMany({ data: [key], skipDuplicates: true });
    await tx.$queryRaw`SELECT "shopperId" FROM "ShopperMarketCart"
      WHERE "shopperId" = ${shopperId} AND "marketId" = ${marketId}::"MarketCode" FOR UPDATE`;
    const stored = await tx.shopperMarketCart.findUniqueOrThrow(lookup);
    const current = snapshot(shopperId, marketId, stored);
    const conflict = (message: string) => ({ status: 409 as const, body: { ...current, message } });
    const prior = await tx.shopperMarketCartOperation.findUnique(receipt);
    if (prior) return prior.requestHash === requestHash ? { status: 200, body: current }
      : conflict("This cart operation already used a different request.");
    if (await tx.shopperCartOperation.findUnique({ where: { shopperId_operationId: { shopperId, operationId } }, select: { operationId: true } })) {
      return conflict("This operation belongs to your previous cart. Review the selected market and try again.");
    }
    if (request.mode === "change" && request.revision !== undefined && request.revision !== current.revision) return conflict(staleMessage);
    if (checks?.merge && !await checks.merge(tx)) return conflict("Some guest items could not be matched to this market. Your guest selections were kept.");

    const stock = checks?.stock ? await checks.stock(tx) : MAX_QUANTITY;
    if (stock === null) return conflict("This offer or quantity is unavailable in your shopping market.");
    const currentLots = readQuantityLots(current.items, stored.lots, current.revision);
    const bought = purchase?.revision == null ? null : subtractPurchasedQuantities(current.items, currentLots, purchase.items, purchase.revision);
    const next = bought ? { ...current, items: bought.items } : nextLines(current, request, stock);
    if (typeof next === "string") return conflict(next);
    const changed = next.items !== current.items || next.saved !== current.saved;
    const row = changed ? await tx.shopperMarketCart.update({ where: lookup.where, data: {
      items: [...next.items], saved: [...next.saved], revision: { increment: 1 },
      lots: bought?.lots ?? updateQuantityLots(next.items, currentLots, current.revision + 1),
    }, select: cartFields }) : null;
    await tx.shopperMarketCartOperation.create({ data: { ...operation, requestHash } });
    return { status: 200, body: row ? snapshot(shopperId, marketId, row) : current };
  });
}
