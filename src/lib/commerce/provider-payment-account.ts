import { createHash } from "node:crypto";
import type { MarketId } from "../../config/markets.ts";

export function providerAccountKey(provider: "PAYPAL" | "SSLCOMMERZ", marketId: MarketId, merchant: string) {
  return createHash("sha256").update(JSON.stringify(["sandbox", provider, marketId, merchant])).digest("hex");
}
