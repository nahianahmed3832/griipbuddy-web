import { getDb, type DbReader } from "../db/client.ts";
import { readStockAllocations } from "../commerce/location-inventory.ts";
import { marketConfiguration } from "../market-config.ts";
import { marketDay } from "../market-calendar.ts";
import { merchantProductEligible } from "../marketplace/market-grants.ts";
import { readIntelligenceCommerce } from "./commerce.ts";
import { catalogVariants, variantInventory, type IntelligenceVariant } from "./inventory-observations.ts";
import { observationCalendar, readIntelligenceSnapshots, snapshotDayLimit } from "./observations.ts";
import type { DemandHistory, IntelligenceInput, IntelligenceUnavailable, InventoryIntelligence } from "./types.ts";
import { intelligenceWindow, windowDays } from "./window.ts";

async function currentInventory(db: DbReader, input: IntelligenceInput, rows: IntelligenceVariant[]): Promise<InventoryIntelligence> {
  const inventory = rows.map(row => variantInventory(row, input.marketId));
  const poolIds = [...new Set(inventory.flatMap(entry => entry.poolIds))];
  const type = inventory[0]?.kind;
  const kind = inventory.every(entry => entry.kind === type) ? type ?? "unknown" : "unknown";
  const available = inventory.length && inventory.every(entry => entry.available !== null)
    ? inventory.reduce((sum, entry) => sum + entry.available!, 0) : null;
  let reserved: number | null = null;
  if (kind === "market" && available !== null) {
    const take = 5_001;
    const attempt = { marketId: input.marketId, commerceEvidence: input.test ? { in: ["fixture", "sandbox"] as ("fixture" | "sandbox")[] } : "production" as const };
    const read = { take, select: { stockAllocations: true } };
    const paypal = await db.payPalCheckout.findMany({ ...read, where: { state: "CAPTURING", attempt } });
    const prepaid = await db.prepaidCheckout.findMany({ ...read, where: { state: { in: ["PREPARING", "AWAITING_PAYMENT"] }, attempt } });
    if (paypal.length + prepaid.length < take) {
      const selected = new Set(poolIds);
      try {
        // Reservation decrements checkout availability immediately. This count
        // exposes the existing hold separately and is not another stock deduction.
        if ([...paypal, ...prepaid].every(row => row.stockAllocations !== null)) {
          reserved = [...paypal, ...prepaid].flatMap(row => readStockAllocations(row.stockAllocations, []))
            .reduce((sum, line) => sum + (selected.has(`${line.locationId}:${line.variantId}`) ? line.quantity : 0), 0);
        }
      } catch { /* Historical malformed reservation rows do not establish a zero. */ }
    }
  }
  return { available, reserved, incoming: null, poolIds, kind };
}

export async function loadDemandHistory(input: IntelligenceInput & { productId: string }, transaction?: DbReader): Promise<DemandHistory | IntelligenceUnavailable> {
  const market = marketConfiguration(input.marketId);
  const window = intelligenceWindow(input, 120);
  const scope = { marketId: market.id, currency: market.currency, window, test: input.test };
  const read = async (db: DbReader) => {
    const commerce = await readIntelligenceCommerce(db, input, window);
    const historic = [...new Set(commerce.orders.flatMap(order => order.lines.map(line => line.variantId)))];
    const catalog = await catalogVariants(db, input, historic, 1_001);
    const inventory = await currentInventory(db, input, catalog.filter(row => row.active && row.product.active &&
      row.product.publication === "ACTIVE" && row.offers.length && (input.test || !row.product.demo) && merchantProductEligible(row.product, market.id)));
    const variantIds = catalog.map(row => row.id);
    const snapshots = await readIntelligenceSnapshots(db, input, window, variantIds);
    return { commerce, snapshots, inventory, variantIds };
  };
  const { commerce, snapshots, inventory, variantIds } = transaction ? await read(transaction)
    : await getDb().$transaction(read, { isolationLevel: "RepeatableRead", timeout: 15_000 });
  if (commerce.overflow || snapshots.length > snapshotDayLimit || variantIds.length > 1_000) return { ...scope, kind: "window-too-large" };
  const within = new Set(variantIds);
  const calendar = observationCalendar(snapshots, variantIds);
  const booked = new Map<string, number>(), returned = new Map<string, number>();
  const seen = new Set<string>();
  for (const order of commerce.orders) {
    const booking = order.outcomes.find(outcome => outcome.kind === "ORDER_ACCEPTED");
    if (booking && !seen.has(booking.id)) {
      seen.add(booking.id);
      const day = marketDay(booking.at, window.timeZone);
      const count = order.lines.reduce((sum, line) => sum + (within.has(line.variantId) ? line.quantity : 0), 0);
      booked.set(day, (booked.get(day) ?? 0) + count);
    }
    for (const line of order.returned) {
      if (!within.has(line.variantId)) continue;
      const day = marketDay(line.at, window.timeZone);
      returned.set(day, (returned.get(day) ?? 0) + line.quantity);
    }
  }
  return { ...scope, kind: "history", inventory, observations: windowDays(window).map(day => ({
    day, bookedUnits: booked.get(day) ?? 0, returnedUnits: returned.get(day) ?? 0,
    ...(calendar.get(day) ?? { availability: "unknown", promotion: "unknown" }),
  })) };
}
