export const retailMarketIds = ["bd", "us"] as const;
export const marketIds = [...retailMarketIds, "ca"] as const;
export type RetailMarketId = (typeof retailMarketIds)[number];
export type MarketId = (typeof marketIds)[number];

type MarketLanguage = "bn" | "en";
type MarketDefinition<T extends MarketId> = {
  id: T;
  countryCode: Uppercase<T>;
  name: string;
  nameBn: string;
  currency: string;
  currencyName: string;
  locale: string;
  locales: Readonly<Partial<Record<MarketLanguage, string>>>;
  languages: readonly MarketLanguage[];
  defaultLanguage: MarketLanguage;
  timeZone: string;
  minorDigits: number;
  pathPrefix: string;
  stagingOnly: boolean;
  addressProfile: "district" | "us" | "ca";
  checkout: "bangladesh" | "paypalSandbox" | null;
  payments: readonly ("COD" | "BKASH" | "NAGAD" | "ROCKET" | "PAYPAL")[];
  fulfillment: "bangladesh" | "manual" | null;
  support: "staff";
};

export const markets = {
  bd: {
    id: "bd", countryCode: "BD", name: "Bangladesh", nameBn: "বাংলাদেশ", currency: "BDT", currencyName: "Bangladeshi Taka",
    locale: "en-BD", locales: { en: "en-BD", bn: "bn-BD" }, languages: ["en", "bn"], defaultLanguage: "en", timeZone: "Asia/Dhaka",
    minorDigits: 2, pathPrefix: "/bd", stagingOnly: false, addressProfile: "district", checkout: "bangladesh",
    payments: ["COD", "BKASH", "NAGAD", "ROCKET"], fulfillment: "bangladesh", support: "staff",
  },
  us: {
    id: "us", countryCode: "US", name: "United States", nameBn: "যুক্তরাষ্ট্র", currency: "USD", currencyName: "US Dollar",
    locale: "en-US", locales: { en: "en-US" }, languages: ["en"], defaultLanguage: "en", timeZone: "America/New_York",
    minorDigits: 2, pathPrefix: "", stagingOnly: false, addressProfile: "us", checkout: "paypalSandbox",
    payments: ["PAYPAL"], fulfillment: "manual", support: "staff",
  },
  ca: {
    id: "ca", countryCode: "CA", name: "Canada", nameBn: "কানাডা", currency: "CAD", currencyName: "Canadian Dollar",
    locale: "en-CA", locales: { en: "en-CA" }, languages: ["en"], defaultLanguage: "en", timeZone: "America/Toronto",
    minorDigits: 2, pathPrefix: "", stagingOnly: true, addressProfile: "ca", checkout: null,
    payments: [], fulfillment: null, support: "staff",
  },
} as const satisfies { [Id in MarketId]: MarketDefinition<Id> };

export type Market = (typeof markets)[MarketId];
export type Currency = Market["currency"];

export const marketList = retailMarketIds.map(id => markets[id]);
export const defaultMarketId = "bd";
export const marketCookie = "griipbuddy-market";

export function isMarketId(value: unknown): value is MarketId {
  return typeof value === "string" && Object.hasOwn(markets, value);
}

export function isStorefrontMarketId(value: unknown, fixtureEnabled: boolean): value is MarketId {
  return isMarketId(value) && (!markets[value].stagingOnly || fixtureEnabled);
}

export function isRetailMarketId(value: unknown): value is RetailMarketId {
  return retailMarketIds.some(id => id === value);
}

export function marketDirectory(fixtureEnabled: boolean): Market[] {
  return marketIds.filter(id => isStorefrontMarketId(id, fixtureEnabled)).map(id => markets[id]);
}

export function getMarket(value: unknown): Market {
  return markets[isMarketId(value) ? value : defaultMarketId];
}

export function marketSupportsLanguage(market: MarketId, language: MarketLanguage) {
  return markets[market].languages.some(item => item === language);
}

export function marketLocale(market: MarketId, language: MarketLanguage) {
  const { locale, locales }: MarketDefinition<MarketId> = markets[market];
  return locales[language] ?? locale;
}

export function formatMoney(amountMinor: number, market: Market): string {
  const minimumFractionDigits = market.currency === "BDT" && amountMinor % 100 === 0 ? 0 : market.minorDigits;
  return new Intl.NumberFormat(market.locale, {
    style: "currency",
    currency: market.currency,
    currencyDisplay: market.stagingOnly ? "code" : "narrowSymbol",
    minimumFractionDigits,
    maximumFractionDigits: market.minorDigits,
  }).format(amountMinor / 10 ** market.minorDigits);
}
