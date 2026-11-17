import { markets, marketSupportsLanguage, type MarketId } from "../../config/markets.ts";

export type AccountLanguage = "en" | "bn";
export const accountLanguageCookie = "griipbuddy-account-language-bd";
export function accountLanguage(market: MarketId, value?: string | null): AccountLanguage {
  return (value === "en" || value === "bn") && marketSupportsLanguage(market, value) ? value : markets[market].defaultLanguage;
}

export function accountText(language: AccountLanguage, english: string, bangla: string) {
  return language === "bn" ? bangla : english;
}

export function accountMarketName(language: AccountLanguage, market: MarketId) {
  return accountText(language, markets[market].name, markets[market].nameBn);
}
