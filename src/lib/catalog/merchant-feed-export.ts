import type { MarketId } from "../../config/markets.ts";
import { integratedCheckout } from "../commerce/integrated-checkout.ts";
import { developmentAcceptanceDatabase, localDatabase } from "../db/local.ts";
import { marketConfiguration, resolveMarketScope } from "../market-config.ts";
import { merchantFeedSettings } from "./merchant-feed-config.ts";
import { collectMerchantFeed, merchantFeedXml, metaFeedConditions, type MerchantFeedItem, type MetaFeedCondition } from "./merchant-feed.ts";
import { catalog } from "./repository.ts";

export const maxSelectedVariants = 50;
type FeedRequest = {
  marketId: MarketId;
  currency: string;
  variantIds: string[];
} & ({ channel: "google" } | { channel: "meta"; condition: MetaFeedCondition });

export function fixtureFeedExportEnabled(marketId: MarketId) {
  const market = marketConfiguration(marketId);
  if (market.status !== "staging" || market.checkoutAuthority !== "native") return false;
  const { origin } = merchantFeedSettings(marketId);
  const local = localDatabase() === "griipbuddy_test" && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname);
  return (local || developmentAcceptanceDatabase()) && !integratedCheckout(marketId);
}

export function parseFeedExport(form: URLSearchParams): FeedRequest | null {
  if ([...form.keys()].some(key => !["market", "currency", "channel", "variant", "condition"].includes(key))) return null;
  const values = (key: string) => form.getAll(key);
  const [market, currency, channel, condition] = ["market", "currency", "channel", "condition"].map(values);
  const scope = currency.length === 1 && market.length === 1 ? resolveMarketScope(market[0], currency[0]) : null;
  const variantIds = values("variant");
  if (!scope || channel.length !== 1 || condition.length > 1 || !variantIds.length || variantIds.length > maxSelectedVariants ||
      new Set(variantIds).size !== variantIds.length || variantIds.some(id => !/^v-[A-Za-z0-9_-]{1,98}$/.test(id))) return null;
  const shared = { marketId: scope.id, currency: scope.currency, variantIds };
  if (channel[0] === "google") return { ...shared, channel: "google" };
  if (channel[0] !== "meta") return null;
  const selectedCondition = metaFeedConditions.find(value => value === condition[0]);
  return selectedCondition ? { ...shared, channel: "meta", condition: selectedCondition } : null;
}

// Preview and export deliberately avoid the hybrid Bangladesh live verification path.
export async function loadFixtureFeedSelection(marketId: MarketId, at?: Date) {
  if (!fixtureFeedExportEnabled(marketId)) throw new Error("Fixture feed export is disabled.");
  const { origin, regional } = merchantFeedSettings(marketId);
  const settings = { marketId, origin, regional };
  const products = await catalog.listProducts({ marketId, at, publishedOffersOnly: true });
  return { settings, ...collectMerchantFeed(products, settings) };
}

export function selectFeedItems(items: readonly MerchantFeedItem[], selection: FeedRequest) {
  const byVariant = new Map(items.filter(item => item.currency === selection.currency &&
    new URL(item.link).searchParams.get("market") === selection.marketId).map(item => [item.variantId, item]));
  return selection.variantIds.every(id => byVariant.has(id)) ? selection.variantIds.map(id => byVariant.get(id)!) : null;
}

export function serializeFixtureFeed(selection: FeedRequest, feed: Awaited<ReturnType<typeof loadFixtureFeedSelection>>) {
  if (feed.settings.marketId !== selection.marketId) return null;
  const selected = selectFeedItems(feed.items, selection);
  if (!selected) return null;
  return merchantFeedXml(selected, feed.settings, selection.channel === "meta" ? { metaCondition: selection.condition } : undefined);
}
