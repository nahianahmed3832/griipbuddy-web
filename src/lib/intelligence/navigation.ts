import type { MarketId } from "../../config/markets.ts";

export const intelligencePath = "/staff/intelligence";
export type IntelligenceView = "overview" | "forecast" | "analyst" | "drafts";
export type IntelligenceScope = "live" | "test";

export function intelligenceUrl(options: { market: MarketId | "all"; scope: IntelligenceScope; view?: IntelligenceView;
  from?: string; to?: string; product?: string; variant?: string; horizon?: number; section?: string }) {
  const { section, ...filters } = options;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value !== undefined) params.set(key, String(value));
  return `${intelligencePath}?${params}${section ? `#${encodeURIComponent(section)}` : ""}`;
}
