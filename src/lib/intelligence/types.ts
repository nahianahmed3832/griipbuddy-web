import type { Currency, MarketId } from "../../config/markets.ts";

export type IntelligenceWindow = { from: string; to: string; fromAt: Date; until: Date; timeZone: string };

export type IntelligenceInput = {
  marketId: MarketId; test: boolean; from?: string; to?: string; now?: Date; productId?: string; variantId?: string;
};

export type SourceQuality = {
  id: string;
  source: string;
  status: "available" | "partial" | "unavailable";
  latestAt: Date | null;
  observed: number | null;
  notes: string;
};

export type DemandDay = {
  day: string;
  bookedUnits: number;
  returnedUnits: number;
  availability: "available" | "stockout" | "partial" | "unknown";
  promotion: "active" | "none" | "unknown";
};

export type InventoryIntelligence = {
  available: number | null;
  reserved: number | null;
  incoming: number | null;
  poolIds: string[];
  kind: "shared" | "market" | "unknown";
};

export type IntelligenceMetrics = {
  impressions: number;
  impressionsByPlacement: { placement: string; count: number }[];
  viewers: number;
  productClicks: number;
  wishlistAdds: number;
  wishlistRemoves: number;
  cartAdds: number;
  cartUpdates: number;
  cartRemoves: number;
  cartSessions: number;
  checkoutSessions: number;
  checkoutErrors: number;
  viewedThenCart: number;
  viewedThenCheckout: number;
  viewedThenPaid: number;
  bookedOrders: number;
  bookedUnits: number;
  discountedUnits: number;
  paidOrders: number;
  paidUnits: number;
  paymentFailures: number | null;
  cancelledOrders: number;
  deliveredOrders: number;
  returnedOrders: number;
  returnedUnits: number;
  codCollectedOrders: number;
  codRemittedOrders: number;
  campaignVisits: { source: string; viewers: number; paidJourneys: number }[];
};

export type ProductFinance = {
  bookedMerchandiseMinor: bigint | null;
  collectedMinor: bigint | null;
  remittedMinor: bigint | null;
  itemCostMinor: bigint | null;
  packagingMinor: bigint | null;
  outboundMinor: bigint | null;
  returnMinor: bigint | null;
  paymentFeesMinor: bigint | null;
  contributionMinor: bigint | null;
  completeOrders: number;
  requiredOrders: number;
  missing: string[];
};

export type ProductIntelligenceRow = {
  productId: string;
  variantId: string | null;
  slug: string;
  name: string;
  variantName: string | null;
  departmentId: string;
  currency: Currency;
  eligible: boolean;
  metrics: IntelligenceMetrics;
  availability: {
    currentPriceMinor: number | null;
    currentDiscountMinor: number | null;
    priceMinMinor: number | null;
    priceMaxMinor: number | null;
    available: number | null;
    stockoutDays: number;
    availableDays: number;
    partialDays: number;
    unknownDays: number;
    promotionDays: number;
    marketDelivery: boolean | null;
    latestSnapshotAt: Date | null;
  };
  finance: ProductFinance;
};

export type SearchIntelligence = {
  searches: number;
  searchers: number;
  zeroResults: number;
  filterChanges: number;
  reformulations: number;
  terms: { term: string; searches: number; searchers: number; zeroResults: number; reformulations: number }[];
};

export type MarketIntelligenceTotals = IntelligenceMetrics & {
  collectedMinor: bigint;
  remittedMinor: bigint;
  unmappedOrders: number;
  unclassifiedOrders: number;
};

export type IntelligenceScope = { marketId: MarketId; currency: Currency; window: IntelligenceWindow; test: boolean };
export type IntelligenceUnavailable = IntelligenceScope & { kind: "window-too-large" };

export type ProductIntelligenceReport = IntelligenceScope & {
  kind: "report";
  products: ProductIntelligenceRow[];
  searches: SearchIntelligence;
  market: MarketIntelligenceTotals;
  quality: SourceQuality[];
};

export type DemandHistory = IntelligenceScope & {
  kind: "history";
  observations: DemandDay[];
  inventory: InventoryIntelligence;
};
