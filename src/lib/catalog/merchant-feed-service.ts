import type { MarketId } from "../../config/markets.ts";
import { merchantBdPreviewPhoto, refreshDevBangladeshMerchantItems } from "./merchant-bd-preview.ts";
import { devLiveBangladeshFeed, merchantFeedSettings } from "./merchant-feed-config.ts";
import { collectMerchantFeed, type MerchantFeedIssue } from "./merchant-feed.ts";
import { catalog } from "./repository.ts";

export async function loadMerchantFeed(marketId: MarketId) {
  const settings = merchantFeedSettings(marketId);
  const products = await catalog.listProducts({ marketId });
  const liveBdPreview = marketId === "bd" && devLiveBangladeshFeed();
  const { items, issues } = collectMerchantFeed(liveBdPreview ? products.map(merchantBdPreviewPhoto) : products, settings);
  if (!liveBdPreview) return { settings, items, issues };

  const live = await refreshDevBangladeshMerchantItems(items);
  const unavailable = new Set(live.unavailableVariantIds);
  const productNames = new Map(products.map(product => [product.id, product.name]));
  const liveIssues: MerchantFeedIssue[] = items.filter(item => unavailable.has(item.variantId)).map(item => ({
    productId: item.productId, productName: productNames.get(item.productId) ?? item.title, variantId: item.variantId,
    code: "live_unverified", severity: "excluded",
  }));
  return { settings, items: live.items, issues: [...issues.filter(issue => !unavailable.has(issue.variantId)), ...liveIssues] };
}
