import { z } from "zod";
import { defaultMarketId, isMarketId, marketIds, markets, type Market, type MarketId } from "../config/markets.ts";

const key = z.string().regex(/^[a-z][a-z0-9-]{1,63}$/);
const locale = z.string().max(35).refine(value => {
  try { return Intl.getCanonicalLocales(value)[0] === value; } catch { return false; }
}, "Use a canonical language tag.");
const timeZone = z.string().max(80).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return !/^[+-]/.test(value); } catch { return false; }
}, "Use an IANA timezone.");
const paymentMethod = z.enum(["COD", "PAYPAL", "SSLCOMMERZ"]);
const evidence = z.enum(["sandbox", "production"]);
const payment = z.strictObject({
  method: paymentMethod,
  adapter: z.enum(["native-cod", "paypal", "sslcommerz"]),
  evidence,
  enabled: z.boolean(),
});
const operationAdapter = z.strictObject({ adapter: z.enum(["manual", "steadfast"]), evidence });

const fields = z.strictObject({
  revision: z.int().positive(),
  status: z.enum(["planned", "staging", "active", "paused"]),
  checkoutAuthority: z.enum(["native", "legacy-handoff"]),
  languages: z.array(locale).min(1).max(8),
  defaultLocale: locale,
  timeZone,
  reportingCalendar: z.strictObject({ type: z.literal("gregory"), weekStartsOn: z.union([z.literal(0), z.literal(1), z.literal(6)]) }),
  pricing: z.strictObject({
    priceList: key, taxTreatment: z.enum(["MERCHANDISE_RATE", "PROVIDER_QUOTE"]), rounding: z.literal("minor-half-up"),
  }),
  address: z.strictObject({ adapter: z.enum(["bd-district", "us-postal"]) }),
  delivery: z.strictObject({ coverage: z.enum(["checkout-policy", "provider-service"]) }),
  payments: z.array(payment).max(9),
  fulfillment: z.array(operationAdapter).max(4),
  returns: z.array(operationAdapter).max(4),
  catalog: z.strictObject({ eligibility: z.literal("market-offer"), sellerPermission: z.literal("market-grant"),
    inventory: z.enum(["market-locations", "shared-legacy"]) }),
  merchandising: z.strictObject({ giftBudgets: z.array(z.int().positive().max(100_000)).max(8) }),
  privacy: z.strictObject({ analyticsConsent: z.literal("opt-in"), honorGlobalPrivacyControl: z.literal(true) }),
  analytics: z.strictObject({ structured: z.enum(["first-party", "disabled"]), clarity: z.enum(["optional", "disabled"]) }),
});

type Fields = z.output<typeof fields>;
export type MarketConfiguration = Market & Fields;
export type MarketEvidence = z.output<typeof evidence>;
export type MarketPaymentMethod = z.output<typeof paymentMethod>;
export const marketIdInput = z.custom<MarketId>(isMarketId, "Choose a configured market.");

const common = {
  revision: 1, status: "staging", checkoutAuthority: "native",
  delivery: { coverage: "checkout-policy" },
  fulfillment: [{ adapter: "manual", evidence: "sandbox" }],
  returns: [{ adapter: "manual", evidence: "sandbox" }],
  catalog: { eligibility: "market-offer", sellerPermission: "market-grant", inventory: "shared-legacy" },
  privacy: { analyticsConsent: "opt-in", honorGlobalPrivacyControl: true },
  analytics: { structured: "first-party", clarity: "optional" },
} as const;
const defaults: Record<MarketId, Fields> = {
  bd: {
    ...common, languages: ["en-BD"], defaultLocale: "en-BD", timeZone: "Asia/Dhaka",
    reportingCalendar: { type: "gregory", weekStartsOn: 0 },
    pricing: { priceList: "bd-retail", taxTreatment: "MERCHANDISE_RATE", rounding: "minor-half-up" },
    address: { adapter: "bd-district" },
    merchandising: { giftBudgets: [600, 1200, 2500] },
    payments: [
      { method: "COD", adapter: "native-cod", evidence: "sandbox", enabled: true },
      { method: "SSLCOMMERZ", adapter: "sslcommerz", evidence: "sandbox", enabled: true },
    ],
    fulfillment: [...common.fulfillment, { adapter: "steadfast", evidence: "sandbox" }],
    returns: [...common.returns, { adapter: "steadfast", evidence: "sandbox" }],
  },
  us: {
    ...common, languages: ["en-US"], defaultLocale: "en-US", timeZone: "America/New_York",
    reportingCalendar: { type: "gregory", weekStartsOn: 1 },
    pricing: { priceList: "us-retail", taxTreatment: "PROVIDER_QUOTE", rounding: "minor-half-up" },
    address: { adapter: "us-postal" },
    merchandising: { giftBudgets: [15, 30, 50] },
    delivery: { coverage: "provider-service" },
    payments: [{ method: "PAYPAL", adapter: "paypal", evidence: "sandbox", enabled: true }],
    fulfillment: [...common.fulfillment],
    returns: [...common.returns],
  },
};

function unique(items: readonly string[]) {
  return items.length === new Set(items).size;
}

const adapters = { COD: "native-cod", PAYPAL: "paypal", SSLCOMMERZ: "sslcommerz" } as const;

function validateMarket(market: Market, raw: unknown): MarketConfiguration {
  const data = fields.parse(raw);
  const { status, languages, defaultLocale, address, payments, fulfillment, returns, analytics } = data;
  if (!languages.includes(defaultLocale) || !unique(languages)) throw new Error("Market languages and default locale must agree.");
  if ((address.adapter === "us-postal" && market.countryCode !== "US") ||
      (address.adapter === "bd-district" && market.countryCode !== "BD")) {
    throw new Error("The address adapter must support the market destination.");
  }
  if (data.checkoutAuthority === "legacy-handoff" && address.adapter !== "bd-district") {
    throw new Error("The legacy checkout handoff requires its supported destination adapter.");
  }
  if (!unique(payments.map(entry => `${entry.method}:${entry.evidence}`)) ||
      !unique(fulfillment.map(entry => `${entry.adapter}:${entry.evidence}`)) ||
      !unique(returns.map(entry => `${entry.adapter}:${entry.evidence}`))) throw new Error("Duplicate market adapters.");
  if (payments.some(entry => entry.adapter !== adapters[entry.method] ||
      (entry.adapter === "paypal" && (market.currency !== "USD" || address.adapter !== "us-postal" || entry.evidence !== "sandbox")) ||
      (entry.adapter === "sslcommerz" && (market.currency !== "BDT" || address.adapter !== "bd-district" || entry.evidence !== "sandbox")))) {
    throw new Error("A payment adapter is incompatible with the market currency, address profile or environment.");
  }
  if ([...fulfillment, ...returns].some(entry => entry.adapter === "steadfast" && market.countryCode !== "BD")) {
    throw new Error("Steadfast requires a supported domestic destination.");
  }
  if (status === "active" || status === "staging") {
    const required = status === "active" ? "production" : "sandbox";
    if (!payments.some(entry => entry.enabled && entry.evidence === required) ||
        !fulfillment.some(entry => entry.evidence === required) || !returns.some(entry => entry.evidence === required)) {
      throw new Error("Operating markets require payment, fulfillment and returns adapters for the declared environment.");
    }
    if (status === "active" && data.pricing.taxTreatment !== "MERCHANDISE_RATE") {
      throw new Error("The production tax adapter requires an explicit merchandise rate.");
    }
    if (status === "active" && data.catalog.inventory !== "market-locations") {
      throw new Error("Production inventory requires market-scoped dispatch locations.");
    }
  }
  if (analytics.clarity !== "disabled" && analytics.structured !== "first-party") {
    throw new Error("Replay requires the existing first-party consent integration.");
  }
  return { ...market, ...data, locale: defaultLocale };
}

const overlays = z.partialRecord(marketIdInput, fields.partial());
let manifestCache: { source: string; production: boolean; entries: Record<MarketId, MarketConfiguration> } | undefined;

export function marketConfigurations(raw: string | undefined, production: boolean): Record<MarketId, MarketConfiguration> {
  const source = raw?.trim() ?? "";
  if (manifestCache?.source === source && manifestCache.production === production) return manifestCache.entries;
  if (source.length > 32_000) throw new Error("Market configuration is too large.");
  // Browsing remains available when production credentials and approval have not been supplied.
  const overrides = source ? overlays.parse(JSON.parse(source)) : {};
  const entries = Object.fromEntries(marketIds.map(id => [id, validateMarket(markets[id], {
    ...defaults[id], ...(production && { status: "paused", catalog: { ...defaults[id].catalog, inventory: "market-locations" } }),
    ...overrides[id],
  })])) as Record<MarketId, MarketConfiguration>;
  if (!marketIds.some(id => entries[id].status !== "planned")) throw new Error("Configure at least one browsable market.");
  manifestCache = { source, production, entries };
  return entries;
}

export function marketConfiguration(marketId: MarketId): MarketConfiguration {
  return marketConfigurations(process.env.GRIIP_MARKET_CONFIGURATION, process.env.COMMERCE_MODE === "production")[marketId];
}

export function isMarketSelectable(value: unknown): value is MarketId {
  return isMarketId(value) && marketConfiguration(value).status !== "planned";
}

export function selectableMarkets(): Array<Market & { languages: readonly string[] }> {
  return marketIds.filter(isMarketSelectable).map(id => {
    const { locale, languages } = marketConfiguration(id);
    return { ...markets[id], locale, languages };
  });
}

export function selectedMarketId(value?: unknown, fallback: MarketId = defaultMarketId): MarketId {
  if (isMarketSelectable(value)) return value;
  const configured = process.env.GRIIP_DEFAULT_MARKET?.trim();
  if (configured && !isMarketSelectable(configured)) throw new Error("GRIIP_DEFAULT_MARKET must name a browsable market.");
  if (isMarketSelectable(configured)) return configured;
  if (isMarketSelectable(fallback)) return fallback;
  return marketIds.find(isMarketSelectable)!;
}

export function marketLanguage(config: MarketConfiguration, preferred: unknown) {
  if (typeof preferred !== "string") return;
  const tag = preferred.toLowerCase();
  return config.languages.find(language => language.toLowerCase() === tag);
}

export function resolveMarketLocale(config: MarketConfiguration, preferred: unknown, accepted: string | null) {
  const requested = marketLanguage(config, preferred);
  if (requested || !accepted) return requested ?? config.defaultLocale;
  const languages = accepted.slice(0, 1024).split(",").map(entry => {
    const [tag, ...params] = entry.trim().split(";");
    const value = params.map(param => param.trim()).find(param => param.startsWith("q="));
    return { tag, weight: value ? Number(value.slice(2)) : 1 };
  }).filter(({ weight }) => weight > 0 && weight <= 1).sort((a, b) => b.weight - a.weight);
  return languages.map(({ tag }) => marketLanguage(config, tag)).find(Boolean) ?? config.defaultLocale;
}

export function marketCanOperate(config: MarketConfiguration, mode: MarketEvidence) {
  return mode === "production"
    ? process.env.COMMERCE_MODE === "production" && config.status === "active"
    : process.env.COMMERCE_MODE !== "production" && config.status === "staging";
}

export function marketPayment(config: MarketConfiguration, method: MarketPaymentMethod, mode: MarketEvidence) {
  return marketCanOperate(config, mode)
    ? config.payments.find(entry => entry.enabled && entry.method === method && entry.evidence === mode)
    : undefined;
}
