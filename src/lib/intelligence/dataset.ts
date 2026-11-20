import { getDb } from "../db/client.ts";
import { marketConfiguration } from "../market-config.ts";
import { marketHasDelivery } from "../commerce/orders.ts";
import { merchantProductEligible } from "../marketplace/market-grants.ts";
import { measurementRetentionDays } from "../measurement/domain.ts";
import { readIntelligenceCommerce } from "./commerce.ts";
import { catalogVariants, variantInventory, variantOffer, type IntelligenceVariant } from "./inventory-observations.ts";
import { addFinance, addObservation, addOutcomes, financialState, metricState, paidEvent, sessionKey, summarizeFinance, summarizeMetrics } from "./metrics.ts";
import { observationCalendar, readIntelligenceBehavior, readIntelligenceSnapshots, searchIntelligence, snapshotDayLimit, type InventorySnapshot } from "./observations.ts";
import type { IntelligenceInput, IntelligenceScope, IntelligenceUnavailable, IntelligenceWindow, ProductIntelligenceReport, ProductIntelligenceRow, SourceQuality } from "./types.ts";
import { intelligenceBatch, intelligenceWindow, windowDays } from "./window.ts";

export type { IntelligenceInput, ProductIntelligenceReport, ProductIntelligenceRow, SearchIntelligence, SourceQuality } from "./types.ts";

const rowLimit = 2_000;
const referenceKey = (id: string, variantId: string | null) => JSON.stringify([id, variantId]);

function summarizeAvailability(variants: readonly IntelligenceVariant[], samples: InventorySnapshot[], window: IntelligenceWindow,
  marketId: IntelligenceScope["marketId"], test: boolean, marketDelivery: boolean | null, now: Date) {
  const eligible = variants.filter(variant => variant.active && variant.product.active && variant.product.publication === "ACTIVE" &&
    merchantProductEligible(variant.product, marketId) && (test || !variant.product.demo) && variantOffer(variant, now));
  const offers = eligible.flatMap(variant => variantOffer(variant, now) ?? []).sort((a, b) => a.price - a.discount - b.price + b.discount);
  const stock = eligible.map(variant => variantInventory(variant, marketId).available);
  const variantIds = (eligible.length ? eligible : variants).map(variant => variant.id);
  const calendar = observationCalendar(samples, variantIds);
  const available = stock.length && stock.every(value => value !== null) ? stock.reduce<number>((sum, value) => sum + value!, 0) : null;
  let priceMinMinor: number | null = null, priceMaxMinor: number | null = null;
  for (const entry of samples) {
    priceMinMinor = Math.min(priceMinMinor ?? entry.minPrice, entry.minPrice);
    priceMaxMinor = Math.max(priceMaxMinor ?? entry.maxPrice, entry.maxPrice);
  }
  const values = [...calendar.values()];
  const current = offers[0];
  const stockoutDays = values.filter(entry => entry.availability === "stockout").length;
  const availableDays = values.filter(entry => entry.availability === "available").length;
  const partialDays = values.filter(entry => entry.availability === "partial").length;
  return {
    currentPriceMinor: current ? current.price - current.discount : null, currentDiscountMinor: current?.discount ?? null,
    priceMinMinor, priceMaxMinor, available, marketDelivery,
    stockoutDays, availableDays, partialDays, unknownDays: windowDays(window).length - stockoutDays - availableDays - partialDays,
    promotionDays: values.filter(entry => entry.promotion === "active").length, latestSnapshotAt: samples.at(-1)?.observedAt ?? null,
  };
}

const latest = (dates: Date[]) => dates.reduce<Date | null>((recent, date) => !recent || date > recent ? date : recent, null);

export async function productIntelligence(input: IntelligenceInput): Promise<ProductIntelligenceReport | IntelligenceUnavailable> {
  const now = input.now ?? new Date();
  const market = marketConfiguration(input.marketId);
  const window = intelligenceWindow(input);
  const { marketId, test } = input;
  const scope = { marketId, currency: market.currency, window, test };
  const unavailable = { ...scope, kind: "window-too-large" as const };
  const [report, marketDelivery] = await Promise.all([
    getDb().$transaction(async db => {
      const behavior = await readIntelligenceBehavior(db, input, window);
      const commerce = await readIntelligenceCommerce(db, input, window);
      const historic = new Set(commerce.orders.flatMap(order => order.lines.map(line => line.variantId)));
      const browserVariants = [...new Set(behavior.flatMap(row => row.variantId ? [row.variantId] : []))];
      for (const row of await db.variant.findMany({ where: { id: { in: browserVariants },
        offers: { some: { marketId, currency: market.currency } } }, select: { id: true }, take: rowLimit + 1 })) historic.add(row.id);
      const variants = await catalogVariants(db, input, [...historic], rowLimit + 1);
      const snapshots = await readIntelligenceSnapshots(db, input, window, variants.map(row => row.id));
      return { behavior, commerce, snapshots, variants };
    }, { isolationLevel: "RepeatableRead", timeout: 20_000 }),
    marketHasDelivery(marketId).catch(() => null),
  ]);
  const { behavior, commerce, snapshots, variants } = report;
  if (commerce.overflow || behavior.length > intelligenceBatch || snapshots.length > snapshotDayLimit || variants.length > rowLimit) return unavailable;

  const catalog = new Map(variants.map(variant => [variant.id, variant]));
  const grouped = new Map<string, { variants: IntelligenceVariant[]; metrics: ReturnType<typeof metricState>; finance: ReturnType<typeof financialState> }>();
  const eligibleProductIds = new Set(variants.map(row => row.productId));
  const stateMarket = metricState();
  const checkoutBaskets = new Map<string, Map<string, string>>();
  for (const row of variants) {
    const productKey = referenceKey(row.productId, null);
    const parent = grouped.get(productKey) ?? { variants: [], metrics: metricState(), finance: financialState() };
    parent.variants.push(row);
    grouped.set(productKey, parent);
    grouped.set(referenceKey(row.productId, row.id), { variants: [row], metrics: metricState(), finance: financialState() });
  }

  const observationKeys = (productId: string, variantId: string | null) => [referenceKey(productId, null), ...(variantId ? [referenceKey(productId, variantId)] : [])];
  for (const event of behavior) {
    const { kind, journeyId, sessionId, variantId } = event;
    const session = sessionKey(journeyId, sessionId);
    const productId = variantId ? catalog.get(variantId)?.productId ?? null : event.productId;
    if ((variantId || productId) && (!productId || !eligibleProductIds.has(productId))) continue;
    addObservation(stateMarket, event);
    if (productId && eligibleProductIds.has(productId)) {
      const keys = observationKeys(productId, variantId);
      for (const key of keys) addObservation(grouped.get(key)!.metrics, event);
      if (variantId && (kind === "CART_ADD" || kind === "CART_REMOVE" || kind === "CART_UPDATE")) {
        const basket = checkoutBaskets.get(session) ?? new Map<string, string>();
        if (kind === "CART_REMOVE" || event.quantity === 0) basket.delete(variantId);
        else basket.set(variantId, productId);
        if (basket.size) checkoutBaskets.set(session, basket);
        else checkoutBaskets.delete(session);
      }
    }
    if (kind === "CHECKOUT_START" || kind === "CHECKOUT_FAILURE") {
      const basket = checkoutBaskets.get(session);
      if (!basket) continue;
      const keys = new Set([...basket].flatMap(([variant, product]) => observationKeys(product, variant)));
      for (const key of keys) addObservation(grouped.get(key)!.metrics, event);
    }
  }

  const outcomeIds = new Set<string>();
  const commerceSources = new Set<string>();
  const commerceEvidence = new Set<string>();
  let unmappedOrders = 0, collectedMinor = 0n, remittedMinor = 0n;
  for (const order of commerce.orders) {
    const outcomes = new Map(order.outcomes.filter(event => {
      if (outcomeIds.has(event.id)) return false;
      outcomeIds.add(event.id);
      return true;
    }).map(event => [event.kind, event]));
    if (!outcomes.size) continue;
    commerceSources.add(order.source);
    commerceEvidence.add(order.evidence);
    const received = order.returned.reduce((sum, row) => sum + row.quantity, 0);
    addOutcomes(stateMarket, outcomes, order.lines, received || null);
    const capture = paidEvent(outcomes)?.amountMinor;
    if (capture !== null && capture !== undefined) collectedMinor += BigInt(capture);
    const remittance = outcomes.get("COD_REMITTED")?.amountMinor;
    if (remittance !== null && remittance !== undefined) remittedMinor += BigInt(remittance);
    const byRow = new Map<string, typeof order.lines>();
    for (const line of order.lines) {
      const variant = catalog.get(line.variantId);
      if (!variant) continue;
      for (const key of observationKeys(variant.productId, variant.id)) {
        const lines = byRow.get(key) ?? [];
        lines.push(line);
        byRow.set(key, lines);
      }
    }
    if (!input.productId && !input.variantId && (!order.lines.length || order.lines.some(line => !catalog.has(line.variantId)))) unmappedOrders++;
    for (const [key, lines] of byRow) {
      const state = grouped.get(key)!;
      const variantIds = new Set(lines.map(line => line.variantId));
      const units = order.returned.reduce((sum, row) => variantIds.has(row.variantId) ? sum + row.quantity : sum, 0);
      addOutcomes(state.metrics, outcomes, lines, units);
      addFinance(state.finance, order, outcomes, lines);
    }
  }

  const samplesByVariant = new Map<string, InventorySnapshot[]>();
  for (const sample of snapshots) {
    const series = samplesByVariant.get(sample.variantId) ?? [];
    series.push(sample);
    samplesByVariant.set(sample.variantId, series);
  }
  const products = [...grouped].map(([key, state]): ProductIntelligenceRow => {
    const { variants, metrics, finance } = state;
    const first = variants[0];
    const variantLevel = key === referenceKey(first.productId, first.id);
    const samples = variants.flatMap(variant => samplesByVariant.get(variant.id) ?? []).sort((a, b) => +a.observedAt - +b.observedAt);
    const availability = summarizeAvailability(variants, samples, window, marketId, test, marketDelivery, now);
    return { productId: first.productId, variantId: variantLevel ? first.id : null, slug: first.product.slug, name: first.product.name,
      variantName: variantLevel ? first.label : null, departmentId: first.product.departmentId,
      currency: market.currency, eligible: availability.currentPriceMinor !== null, metrics: summarizeMetrics(metrics), availability,
      finance: summarizeFinance(finance, market.currency) };
  }).sort((a, b) => Number(b.variantId === null) - Number(a.variantId === null) || b.metrics.bookedUnits - a.metrics.bookedUnits || a.name.localeCompare(b.name));

  const providerFailures = commerce.paymentFailures.length ? commerce.paymentFailures.length : null;
  const quality: SourceQuality[] = [
    { id: "behavior", source: "First-party measurement event schema", status: market.analytics.structured === "disabled" ? "unavailable" : "partial",
      latestAt: latest(behavior.map(row => row.receivedAt)), observed: behavior.length,
      notes: `Consenting browser journeys only. Browser measurement is retained for ${measurementRetentionDays} days. Known staff, automated and out-of-scope journeys are excluded. Historical bot classification is incomplete.` },
    { id: "commerce", source: [...commerceSources].join(", ") || "Committed order and outcome adapters",
      status: commerce.unclassified || unmappedOrders || !commerceSources.size ? "partial" : "available",
      latestAt: latest(commerce.orders.flatMap(row => row.outcomes.map(event => event.at))), observed: outcomeIds.size,
      notes: `${[...commerceEvidence].sort().join(", ") || "No classified outcomes in this period"}. ${unmappedOrders} orders have incomplete variant mapping. ${commerce.unclassified} unclassified native bookings are excluded.` },
    { id: "payment-failures", source: "Verified provider failure adapters", status: providerFailures === null ? "unavailable" : "partial",
      latestAt: latest(commerce.paymentFailures.map(row => row.at)), observed: providerFailures,
      notes: "Adapters provide market-level provider failures when saved. Checkout errors are measured separately. Product-level failure allocation is unavailable when a failed attempt has no retained line mapping." },
    { id: "availability", source: [...new Set(snapshots.flatMap(row => row.sources))].join(", ") || "Scheduled offer and inventory observations",
      status: snapshots.length ? "partial" : "unavailable", latestAt: snapshots.at(-1)?.observedAt ?? null, observed: snapshots.reduce((total, row) => total + row.observed, 0),
      notes: "Stock and price are sampled. Uncovered days remain unknown. Delivery availability is market-wide. Exact address and incoming stock coverage are unavailable here." },
    { id: "returns", source: "Verified parcel and return-case line evidence", status: "partial", latestAt: null, observed: null,
      notes: "Partial returns require recorded line quantities. Legacy receipt-only returns can affect market order counts, with variant quantities unavailable." },
    { id: "finance", source: "Committed merchandise lines and OrderContributionEvidence", status: products.some(row => row.finance.completeOrders) ? "partial" : "unavailable",
      latestAt: latest(commerce.orders.flatMap(row => row.verified ? [row.verified.verifiedThrough] : [])),
      observed: products.filter(row => row.variantId === null).reduce((sum, row) => sum + row.finance.completeOrders, 0),
      notes: "Missing or stale costs and unallocated shared shipping, payment or return costs leave contribution unavailable." },
    { id: "advertising", source: "Consented campaign source labels", status: "partial", latestAt: null, observed: null,
      notes: "Onsite campaign labels and linked paid journeys use the first product view in the measured tab within seven days. Authorized spend, offsite impressions and platform attribution are unavailable." },
  ];
  return { ...scope, kind: "report", products, searches: searchIntelligence(behavior), quality,
    market: { ...summarizeMetrics(stateMarket, providerFailures), collectedMinor, remittedMinor, unmappedOrders, unclassifiedOrders: commerce.unclassified } };
}
