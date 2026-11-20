import { type MarketId } from "../../config/markets.ts";
import { isMarketSelectable, marketForStorefrontOrigin } from "../market-config.ts";
import type { FinanceStatement } from "./seller-finance.ts";
import { sellerOrderRange } from "./seller-order-range.ts";

export type FinanceQuery = {
  market?: string | string[];
  shop?: string | string[];
  from?: string | string[];
  to?: string | string[];
};

export function financeScope(query: FinanceQuery, selected: MarketId, origin?: string) {
  const bound = origin ? marketForStorefrontOrigin(origin) : undefined;
  if (query.market !== undefined && (!isMarketSelectable(query.market) || bound && query.market !== bound)) return null;
  if (query.shop !== undefined && query.shop !== "" && (typeof query.shop !== "string" || !/^[a-f0-9-]{36}$/iu.test(query.shop))) return null;
  const marketId = isMarketSelectable(query.market) ? query.market : bound || selected;
  return { marketId, shopId: typeof query.shop === "string" && query.shop ? query.shop : undefined,
    range: sellerOrderRange(query.from, query.to, new Date(), marketId) };
}

export function financeExportQuery(url: URL): FinanceQuery {
  const { searchParams } = url;
  const read = (key: string) => {
    const values = searchParams.getAll(key);
    return values.length > 1 ? values : values[0];
  };
  return { market: read("market"), shop: read("shop"), from: read("from"), to: read("to") };
}

function csvField(value: string | number) {
  if (typeof value === "number") return String(value);
  const safe = /^[\s\uFEFF]*[=+\-@\t\r\n]/u.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}

export function financeStatementCsv(statement: FinanceStatement) {
  const columns = ["Market", "Currency", "Organization", "Order", "Event", "Source event UTC", "Recorded UTC", "Policy version",
    "Source ID", "Gross minor", "Discount minor", "Tax minor", "Shipping minor", "Commission minor",
    "Fee minor", "Refund minor", "Seller net minor"];
  const shops = new Map(statement.shops.map(shop => [shop.id, shop.name]));
  const rows = statement.entries.map(entry => [
    statement.marketId, statement.currency, shops.get(entry.shopId) ?? entry.shopId, entry.orderReference,
    entry.kind, entry.sourceAt.toISOString(), entry.createdAt.toISOString(), entry.policyVersion, entry.sourceId, entry.grossMinor,
    entry.discountMinor, entry.taxMinor, entry.shippingMinor, entry.commissionMinor, entry.feeMinor, entry.refundMinor, entry.netMinor,
  ]);
  return [columns, ...rows].map(row => row.map(value => csvField(value ?? "")).join(",")).join("\r\n") + "\r\n";
}
