import { z } from "zod";
import { marketIds, marketList, type Currency, type MarketId } from "../../config/markets.ts";
import { shiftCalendarDay } from "../market-calendar.ts";
import type { DemandForecast } from "./forecast.ts";

const wholeUnits = z.int().min(0).max(10_000_000);
const minorAmount = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const date = z.string().refine(value => Boolean(shiftCalendarDay(value, 0)));

const purchasingPolicyInput = z.strictObject({
  poolId: z.string().trim().min(1).max(180),
  variantId: z.string().trim().min(1).max(160),
  markets: z.array(z.enum(marketIds)).min(1).max(marketIds.length).refine(items => new Set(items).size === items.length),
  currency: z.enum([...new Set(marketList.map(market => market.currency))]),
  source: z.string().trim().min(1).max(140),
  asOfDay: date,
  leadTimeDays: z.int().min(1).max(48),
  reviewDays: z.int().min(1).max(28),
  supplierOnTimeRate: z.number().min(0).max(1),
  safetyStockUnits: wholeUnits,
  serviceTarget: z.number().min(0.5).max(0.99),
  minimumOrderUnits: wholeUnits.min(1),
  unitsPerCase: wholeUnits.min(1),
  shelfLifeDays: z.int().min(1).max(3650).nullable(),
  unitCostMinor: minorAmount,
  availableBudgetMinor: minorAmount.nullable(),
  reservedUnits: wholeUnits,
  incoming: z.array(z.strictObject({ id: z.string().trim().min(1).max(100), units: wholeUnits.min(1), expectedOn: date })).max(100)
    .refine(rows => new Set(rows.map(row => row.id)).size === rows.length),
}).refine(policy => policy.leadTimeDays + policy.reviewDays <= 56, "Supplier lead time plus review cadence cannot exceed 56 days.");

export type PurchasingPolicy = z.infer<typeof purchasingPolicyInput>;

export function purchasingPolicies(configured?: string): { state: "unavailable" | "invalid" | "ready"; policies: PurchasingPolicy[] } {
  if (!configured) return { state: "unavailable", policies: [] };
  try {
    if (configured.length > 2_000_000) return { state: "invalid", policies: [] };
    const parsed = z.array(purchasingPolicyInput).max(1000).safeParse(JSON.parse(configured));
    if (!parsed.success) return { state: "invalid", policies: [] };
    const identities = parsed.data.map(item => JSON.stringify([item.poolId, item.variantId]));
    if (new Set(identities).size !== identities.length) return { state: "invalid", policies: [] };
    return { state: "ready", policies: parsed.data };
  } catch {
    return { state: "invalid", policies: [] };
  }
}

export type InventoryPosition = {
  variantId: string;
  kind: "shared" | "market" | "unknown";
  poolIds: readonly string[];
  available: number | null;
  reserved: number | null;
  incoming: number | null;
};

export type InventoryRecommendation = {
  action: "replenish" | "investigate" | "test" | "hold" | "reduce-exposure";
  variantId: string;
  poolId: string | null;
  quantity: number | null;
  available: number | null;
  reserved: number | null;
  incomingDuringHorizon: number | null;
  forecastUpperUnits: number | null;
  currency: Currency | null;
  estimatedCostMinor: number | null;
  unitCostMinor: number | null;
  availableBudgetMinor: number | null;
  source: string | null;
  sourceAsOfDay: string | null;
  markets: readonly MarketId[];
  reasons: string[];
  missingInputs: string[];
};

const verifiedStock = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export function recommendInventory(input: {
  position: InventoryPosition;
  marketId: MarketId;
  marketCurrency: Currency;
  deliveryAvailable: boolean | null;
  snapshotDay: string;
  forecasts: readonly DemandForecast[];
  policy?: PurchasingPolicy;
  authorizedMarkets?: readonly MarketId[];
  consolidatedReview?: boolean;
  /** All consuming markets independently identified from the inventory mode. */
  sharedConsumers?: readonly MarketId[];
}): InventoryRecommendation {
  const { position, marketId, marketCurrency, snapshotDay, forecasts, policy } = input;
  const poolId = position.poolIds.length === 1 ? position.poolIds[0] : null;
  const base = {
    variantId: position.variantId, poolId, quantity: null, available: position.available, reserved: position.reserved,
    incomingDuringHorizon: null, forecastUpperUnits: null, currency: null, estimatedCostMinor: null,
    unitCostMinor: null, availableBudgetMinor: null, source: null, sourceAsOfDay: null, markets: [marketId], reasons: [], missingInputs: [],
  } satisfies Omit<InventoryRecommendation, "action">;
  const investigate = (reason: string, missingInputs = [] as string[]): InventoryRecommendation => ({
    ...base, action: "investigate", reasons: [reason], missingInputs,
  });
  if (!poolId || position.kind === "unknown" || !verifiedStock(position.available)) {
    return investigate("Confirm the physical inventory location before assigning a quantity.", ["Single physical pool and available stock"]);
  }
  if (input.deliveryAvailable !== true) {
    return investigate("Confirm delivery coverage before procuring units for this market.", ["Active delivery coverage"]);
  }
  const together = position.kind === "shared";
  const consumers = together ? [...new Set(input.sharedConsumers ?? [])].sort() : [marketId];
  if (together && (!input.consolidatedReview || consumers.length < 2 || consumers[0] !== marketId ||
      consumers.some(id => !input.authorizedMarkets?.includes(id)))) {
    return investigate("Review this pool once for all consuming markets so the same stock is not allocated twice.", ["Authorized combined pool review"]);
  }
  const purchase = purchasingPolicyInput.safeParse(policy);
  if (!purchase.success || purchase.data.poolId !== poolId || purchase.data.variantId !== position.variantId) {
    const analogue = forecasts.some(forecast => forecast.identity.marketId === marketId && forecast.status === "analogue");
    return { ...base, action: analogue ? "test" : "investigate", reasons: [analogue
      ? "Test a small assortment before planning repeat procurement from comparable products."
      : "Confirm supplier and purchasing assumptions before submitting a proposal."],
    missingInputs: ["Supplier lead time and reliability", "Confirmed reservations and incoming dates", "MOQ and case size",
      "Safety stock and service target", "Cost and purchasing currency", "Shelf-life policy"] };
  }
  const current = purchase.data;
  const policyAge = shiftCalendarDay(snapshotDay, -7);
  if (!policyAge || current.asOfDay < policyAge || current.asOfDay > snapshotDay ||
      current.markets.length !== consumers.length || consumers.some(id => !current.markets.includes(id)) ||
      !together && current.currency !== marketCurrency) {
    return investigate("Refresh the dated purchasing inputs for this pool, with the authorized market coverage and procurement currency.",
      ["Recent market-scoped purchasing policy"]);
  }
  if ((position.reserved !== null && position.reserved !== current.reservedUnits) || (position.incoming !== null &&
      position.incoming !== current.incoming.reduce((total, row) => total + row.units, 0))) {
    return investigate("Operator evidence and the inventory source disagree. Reconcile held and incoming stock.", ["Reconciled reserved and incoming stock"]);
  }
  const horizon = current.leadTimeDays + current.reviewDays;
  const replenishmentDay = shiftCalendarDay(snapshotDay, current.leadTimeDays)!;
  const horizonEnd = shiftCalendarDay(snapshotDay, horizon - 1)!;
  if (current.incoming.some(row => row.expectedOn < snapshotDay)) {
    return investigate("Confirm or reschedule overdue inbound orders before counting them as available.", ["Updated incoming dates"]);
  }
  const incomingDuringHorizon = current.incoming.filter(row => row.expectedOn <= horizonEnd).reduce((total, row) => total + row.units, 0);
  const resultBase = { ...base, reserved: current.reservedUnits, incomingDuringHorizon, markets: consumers,
    currency: current.currency, unitCostMinor: current.unitCostMinor, availableBudgetMinor: current.availableBudgetMinor,
    source: current.source, sourceAsOfDay: current.asOfDay };
  const earlyIncoming = current.incoming.filter(row => row.expectedOn <= replenishmentDay).reduce((total, row) => total + row.units, 0);
  if (current.supplierOnTimeRate < 0.8) {
    return { ...resultBase, action: !position.available && !earlyIncoming ? "reduce-exposure" : "investigate",
      reasons: ["The supplier’s recorded on-time rate is below the purchasing threshold. Confirm an alternative or expedite a reliable delivery."],
      missingInputs: ["Reliable procurement timetable"] };
  }
  const matching = consumers.map(id => forecasts.filter(forecast => forecast.identity.marketId === id &&
    forecast.identity.variantId === position.variantId && forecast.asOfDay === snapshotDay && forecast.horizonDays === horizon));
  const scoped = matching.map(rows => rows.length === 1 ? rows[0] : null);
  if (scoped.some(forecast => !forecast || forecast.status !== "ready" || forecast.pointUnits === null ||
      !forecast.interval || forecast.interval.nominalCoverage < current.serviceTarget)) {
    const rationale = scoped.some(forecast => forecast?.status === "analogue")
      ? "Test the product before planning procurement using analogue demand."
      : "Get a calibrated forecast for every covered market at the supplier lead time plus review cadence.";
    return { ...resultBase, action: scoped.some(forecast => forecast?.status === "analogue") ? "test" : "investigate",
      reasons: [rationale], missingInputs: [`${horizon}-day forecast range at the configured coverage`] };
  }
  // Checkout already debits reserved units from 'available'. Deducting them again overstates the shortage.
  const forecastUpperUnits = scoped.reduce((total, forecast) => total + forecast!.interval!.upperUnits, 0);
  const point = scoped.reduce((total, forecast) => total + forecast!.pointUnits!, 0);
  const need = Math.max(0, forecastUpperUnits + current.safetyStockUnits - position.available - incomingDuringHorizon);
  const result = { ...resultBase, forecastUpperUnits };
  if (!position.available && !earlyIncoming && incomingDuringHorizon > earlyIncoming) {
    return { ...result, action: "investigate", reasons: ["The pool is out of stock and inbound units arrive after the standard lead time. Verify expedited options before relying on those receipts."] };
  }
  if (!need) {
    return { ...result, action: "hold", reasons: ["Available units and confirmed incoming cover the lead-time demand range plus safety stock."] };
  }
  const quantity = Math.ceil(Math.max(current.minimumOrderUnits, need) / current.unitsPerCase) * current.unitsPerCase;
  const totalCost = quantity * current.unitCostMinor;
  if (!Number.isSafeInteger(quantity) || !Number.isSafeInteger(totalCost)) {
    return { ...result, action: "investigate", reasons: ["Proposal quantity or cost exceeds supported planning limits."] };
  }
  if (current.shelfLifeDays !== null && quantity > Math.floor(point * Math.min(1, current.shelfLifeDays / horizon))) {
    return { ...result, action: "investigate", reasons: ["The proposed order could exceed expected sales during its usable shelf life."] };
  }
  if (current.availableBudgetMinor !== null && totalCost > current.availableBudgetMinor) {
    return { ...result, action: "investigate", reasons: ["The minimum or case-sized order exceeds the available purchasing budget."] };
  }
  return { ...result, action: "replenish", quantity, estimatedCostMinor: totalCost, reasons: [
    `Plan for ${forecastUpperUnits} upper-range units over ${horizon} days and ${current.safetyStockUnits} units of safety stock. Quantity is rounded up to the minimum order and case size.`,
    ...(together ? ["The sum of market upper ranges is a planning scenario, with shared stock counted once."] : []),
  ] };
}
