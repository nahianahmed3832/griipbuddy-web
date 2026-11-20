import type { Prisma } from "../../generated/prisma/client.ts";
import { integratedCheckout, readRecoveredOrder } from "../commerce/integrated-checkout.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { addToItems, cartItemKey, decodeCart, MAX_QUANTITY, purchasedCartItem, updateItems, type CartItem } from "./model.ts";
import type { CartChange, CartSyncRequest, CartSyncSnapshot } from "./sync-contract.ts";

type CartLines = Pick<CartSyncSnapshot, "items" | "saved">;
type Mutation = Exclude<CartSyncRequest, { mode: "read" }>;
type LineChange = Exclude<CartChange, { type: "complete-purchase" }>;
type SyncResult = { status: 200; body: CartSyncSnapshot }
  | { status: 409; body: CartSyncSnapshot & { message: string } }
  | { status: 403 | 404; body: { message: string } };

const cartFields = { revision: true, items: true, saved: true } satisfies Prisma.ShopperCartSelect;
const staleMessage = "This item changed on another device. Review the updated cart and try again.";
const capacityMessage = "The cart or saved list is full. Remove an item or reduce a quantity and try again.";

function snapshot(shopperId: string, row: { revision: number; items: Prisma.JsonValue; saved: Prisma.JsonValue } | null): CartSyncSnapshot {
  return {
    shopperId, revision: row?.revision ?? 0,
    items: row ? decodeCart(JSON.stringify(row.items)) : [], saved: row ? decodeCart(JSON.stringify(row.saved)) : [],
  };
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

function applyLineChange(current: CartLines, command: LineChange, stock: number): CartLines | string {
  const { variantId, personalization, offerId } = command;
  if (command.type === "add") {
    const items = addToItems(current.items, variantId, command.quantity, stock, personalization, offerId);
    return items ? { ...current, items } : capacityMessage;
  }

  const key = cartItemKey(command);
  const source = command.type === "remove-saved" || command.type === "restore-saved" ? "saved" : "items";
  const line = current[source].find(item => cartItemKey(item) === key);
  if (command.expectedQuantity !== undefined && line?.quantity !== command.expectedQuantity) return staleMessage;
  if (!line) return command.type === "remove" || command.type === "remove-saved" ? current : staleMessage;

  switch (command.type) {
    case "set": {
      if (line.quantity === command.quantity) return current;
      const items = updateItems(current.items, variantId, command.quantity, stock, personalization, offerId);
      return items === current.items ? capacityMessage : { ...current, items };
    }
    case "move-to-saved": {
      const saved = addToItems(current.saved.filter(item => cartItemKey(item) !== key), variantId, line.quantity, MAX_QUANTITY, personalization, offerId);
      return saved ? { items: current.items.filter(item => cartItemKey(item) !== key), saved } : capacityMessage;
    }
    case "restore-saved": {
      const items = addToItems(current.items, variantId, line.quantity, stock, personalization, offerId);
      return items ? { items, saved: current.saved.filter(item => cartItemKey(item) !== key) } : capacityMessage;
    }
    case "remove":
      return { ...current, items: current.items.filter(item => cartItemKey(item) !== key) };
    case "remove-saved":
      return { ...current, saved: current.saved.filter(item => cartItemKey(item) !== key) };
  }
}

function subtractPurchase(current: CartLines, purchased: readonly CartItem[]): CartLines {
  const quantities = new Map<string, number>();
  for (const line of purchased) {
    const key = cartItemKey(line);
    quantities.set(key, (quantities.get(key) ?? 0) + line.quantity);
  }
  let changed = false;
  const items = current.items.flatMap(line => {
    const quantity = line.quantity - (quantities.get(cartItemKey(line)) ?? 0);
    if (quantity === line.quantity) return [line];
    changed = true;
    return quantity > 0 ? [{ ...line, quantity }] : [];
  });
  return changed ? { ...current, items } : current;
}

async function purchasedItems(shopperId: string, orderId: string, guestKey?: string | null): Promise<CartItem[] | null> {
  const db = getDb();
  const order = await db.order.findFirst({
    where: { id: orderId, status: "PLACED", OR: [
      { shopperId }, ...(guestKey ? [{ shopperId: null, attempt: { guestKey } }] : []),
    ] },
    select: { items: { select: {
      variantId: true, personalization: true, quantity: true, cartVariantIdSnapshot: true, cartOfferIdSnapshot: true,
    } } },
  });
  if (order) return order.items.map(({ cartVariantIdSnapshot, cartOfferIdSnapshot, ...item }) => purchasedCartItem({
    ...item, cartVariantId: cartVariantIdSnapshot ?? undefined, cartOfferId: cartOfferIdSnapshot ?? undefined,
  }));
  if (!guestKey || !integratedCheckout()) return null;
  const recovered = await readRecoveredOrder(orderId, guestKey);
  return recovered && recovered.status !== "cancelled"
    ? recovered.original.lines.map(line => ({ variantId: `v-${line.variantId}`, quantity: line.quantity })) : null;
}

function nextLines(current: CartLines, request: Mutation, purchase: readonly CartItem[] | null, stock: number): CartLines | string {
  if (request.mode === "merge") {
    const items = mergeItems(current.items, request.items);
    const saved = mergeItems(current.saved, request.saved);
    return items && saved ? { items, saved } : capacityMessage;
  }
  return request.command.type === "complete-purchase" ? subtractPurchase(current, purchase ?? []) : applyLineChange(current, request.command, stock);
}

export async function syncShopperCart(shopperId: string, request: CartSyncRequest, guestKey?: string | null,
  checkStock?: (reader: DbReader) => Promise<number | null>): Promise<SyncResult> {
  if (request.shopperId !== shopperId) return { status: 403, body: { message: "The signed-in account changed. Refresh the page." } };
  const db = getDb();
  const lookup = { where: { shopperId }, select: cartFields };
  if (request.mode === "read") {
    return { status: 200, body: snapshot(shopperId, await db.shopperCart.findUnique(lookup)) };
  }

  const orderId = request.mode === "change" && request.command.type === "complete-purchase" ? request.command.orderId : null;
  const operationId = orderId ?? request.operationId;
  const operation = { shopperId, operationId };
  const receipt = { where: { shopperId_operationId: operation }, select: { operationId: true } };
  // Resolve payment data before acquiring the cart lock. Recovered checkout can require a separate service.
  let purchase: CartItem[] | null = null;
  if (orderId) {
    if (await db.shopperCartOperation.findUnique(receipt)) {
      return { status: 200, body: snapshot(shopperId, await db.shopperCart.findUnique(lookup)) };
    }
    purchase = await purchasedItems(shopperId, orderId, guestKey);
    if (!purchase) return { status: 404, body: { message: "That completed order was not found." } };
  }

  return db.$transaction(async tx => {
    // INSERT ON CONFLICT safely establishes the row for shoppers using two devices for the first time.
    await tx.shopperCart.createMany({ data: [{ shopperId, items: [], saved: [] }], skipDuplicates: true });
    await tx.$queryRaw`SELECT "shopperId" FROM "ShopperCart" WHERE "shopperId" = ${shopperId} FOR UPDATE`;
    const current = snapshot(shopperId, await tx.shopperCart.findUniqueOrThrow(lookup));
    if (await tx.shopperCartOperation.findUnique(receipt)) return { status: 200, body: current };

    const stock = checkStock ? await checkStock(tx) : MAX_QUANTITY;
    if (stock === null) return { status: 409, body: { ...current, message: "This offer or quantity is unavailable in your shopping market." } };
    const next = nextLines(current, request, purchase, stock);
    if (typeof next === "string") return { status: 409, body: { ...current, message: next } };
    const changed = next.items !== current.items || next.saved !== current.saved;
    const row = changed ? await tx.shopperCart.update({ where: { shopperId }, data: {
      items: [...next.items], saved: [...next.saved], revision: { increment: 1 },
    }, select: cartFields }) : null;
    await tx.shopperCartOperation.create({ data: operation });
    return { status: 200, body: row ? snapshot(shopperId, row) : current };
  });
}
