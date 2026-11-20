import type { Prisma } from "../../generated/prisma/client.ts";
import { markets, type MarketId } from "../../config/markets.ts";
import type { NormalizedCheckout, NormalizedPrepaidCheckout, OrderPlaced, QuoteLine } from "./checkout-types.ts";
import { CommerceError } from "./errors.ts";
import { finalizeInventoryReservation, InventoryReservationError, releaseInventoryReservation, reserveInventory } from "./inventory-reservations.ts";
import { changeAllocatedStock, lockVariantInventory, readStockAllocations, reserveCheckoutStock, type StockAllocation } from "./location-inventory.ts";
import type { InventoryDestination } from "./physical-inventory.ts";

type Tx = Prisma.TransactionClient;
type CheckoutContext = {
  attemptId: string; guestKey: string; checkoutHash: string; marketId: MarketId;
  paymentMethod: "COD" | "PAYPAL" | "SSLCOMMERZ";
  destination: InventoryDestination;
};
type Reservation = Awaited<ReturnType<typeof reserveInventory>>;
type PaymentProof = { reference: string; currency: string; amountMinor: number };

export function purchaseContext(input: NormalizedCheckout | NormalizedPrepaidCheckout,
  attemptId: string, guestKey: string, checkoutHash: string): CheckoutContext {
  const { marketId, paymentMethod, customer, deliveryMethod: method } = input;
  return { marketId, paymentMethod, attemptId, guestKey, checkoutHash, destination: {
    country: customer.country ?? markets[marketId].countryCode, district: customer.district, postalCode: customer.postalCode, method,
  } };
}

function connectedRequest(context: CheckoutContext, lines: readonly QuoteLine[]) {
  const requested = new Map<string, { variantId: string; offerId: string; revision: number; amountMinor: number; quantity: number }>();
  for (const line of lines) {
    if (!line.offerIdSnapshot) continue;
    if (line.offerRevision === undefined) throw new Error("The connected quote has no offer revision.");
    const previous = requested.get(line.variantId);
    if (previous) previous.quantity += line.quantity;
    else requested.set(line.variantId, { variantId: line.variantId, offerId: line.offerIdSnapshot, revision: line.offerRevision,
      amountMinor: line.unitPriceMinor - line.unitDiscountMinor, quantity: line.quantity });
  }
  return { ...context, lines: [...requested.values()] };
}

export async function reservePurchaseStock(tx: Tx, context: CheckoutContext, lines: readonly QuoteLine[]) {
  const request = connectedRequest(context, lines);
  if (request.lines.length) {
    try {
      const reservation = await reserveInventory(tx, request);
      if (reservation.state !== "HELD") throw new CommerceError({ kind: "conflict", message: "The stock reservation ended. Review your cart again." });
    } catch (error) {
      if (error instanceof InventoryReservationError) {
        throw new CommerceError({ kind: error.code === "conflict" ? "conflict" : "unavailable", message: error.message });
      }
      throw error;
    }
  }
  const legacy = lines.filter(line => !line.offerIdSnapshot);
  return legacy.length ? reserveCheckoutStock(tx, context.marketId, legacy) : [];
}

export function legacyPurchaseStock(value: Prisma.JsonValue | null, lines: readonly QuoteLine[]) {
  const legacy = lines.filter(line => !line.offerIdSnapshot);
  return legacy.length ? readStockAllocations(value, legacy) : [];
}

export async function releasePurchaseStock(tx: Tx, attemptId: string, marketId: MarketId,
  method: "PAYPAL" | "SSLCOMMERZ", legacy: readonly StockAllocation[]) {
  const connected = await tx.inventoryReservation.findUnique({
    where: { attemptId }, select: { allocations: { select: { pool: { select: { variantId: true } } } } },
  });
  await lockVariantInventory(tx, [...legacy.map(line => line.variantId), ...connected?.allocations.map(line => line.pool.variantId) ?? []]);
  if (legacy.length) await changeAllocatedStock(tx, legacy, false);
  if (connected) {
    await releaseInventoryReservation(tx, attemptId, { kind: "provider-closed", marketId, paymentMethod: method });
  }
}

async function connectedParcelLines(tx: Tx, reservation: Reservation, lines: readonly QuoteLine[]) {
  const parcels: StockAllocation[] = [];
  const locations = await tx.dispatchLocation.findMany({
    where: { id: { in: [...new Set(reservation.allocations.map(allocation => allocation.pool.locationId))] } },
    select: { id: true, name: true },
  });
  const names = new Map(locations.map(location => [location.id, location.name]));
  const remaining = new Map(reservation.allocations.map(allocation => [allocation.id, allocation.quantity]));
  for (const line of lines) {
    if (!line.offerIdSnapshot) continue;
    let quantityLeft = line.quantity;
    for (const allocation of reservation.allocations) {
      if (allocation.pool.variantId !== line.variantId || allocation.offerId !== line.offerIdSnapshot) continue;
      const quantity = Math.min(quantityLeft, remaining.get(allocation.id) ?? 0);
      if (!quantity) continue;
      const locationId = allocation.pool.locationId;
      const locationName = names.get(locationId);
      if (!locationName) throw new Error("A reserved dispatch location is missing.");
      parcels.push({ variantId: line.variantId, personalization: line.personalization ?? "", quantity, locationId, locationName });
      remaining.set(allocation.id, (remaining.get(allocation.id) ?? 0) - quantity);
      quantityLeft -= quantity;
      if (!quantityLeft) break;
    }
    if (quantityLeft) throw new Error("Reserved quantities do not match the purchased lines.");
  }
  if ([...remaining.values()].some(Boolean)) throw new Error("A purchase did not use its full reserved allocation.");
  return parcels;
}

export async function placeReservedPurchase(tx: Tx, context: CheckoutContext, lines: readonly QuoteLine[], legacy: readonly StockAllocation[],
  createOrder: (tx: Tx, allocations: readonly StockAllocation[]) => Promise<OrderPlaced>, verified?: PaymentProof) {
  const recovery = connectedRequest(context, lines);
  if (!recovery.lines.length) return createOrder(tx, legacy);
  await lockVariantInventory(tx, lines.map(line => line.variantId));
  const settlement = verified
    ? { kind: "verified-payment", paymentMethod: context.paymentMethod, marketId: context.marketId, ...verified, recovery }
    : { kind: "cod", guestKey: context.guestKey, checkoutHash: context.checkoutHash };
  let placed: OrderPlaced | undefined;
  const result = await finalizeInventoryReservation(tx, context.attemptId, settlement, async (sameTransaction, reservation) => {
    placed = await createOrder(sameTransaction, [...legacy, ...await connectedParcelLines(sameTransaction, reservation, lines)]);
    return placed.orderId;
  });
  if (result.kind === "refund_required") {
    // The connected reservation records this exception once. Restore any mixed legacy lines on that same transition.
    if (result.newlyRecorded && legacy.length) await changeAllocatedStock(tx, legacy, false);
    return result;
  }
  if (!placed) throw new CommerceError({ kind: "conflict", message: "The stock reservation ended. Review your cart again." });
  return placed;
}
