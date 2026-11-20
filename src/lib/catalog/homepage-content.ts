import { cache } from "react";
import type { MarketId } from "../../config/markets.ts";
import { getDb, type DbReader } from "../db/client.ts";
import type { MarketConfiguration } from "../market-config.ts";
import { stableMeasurementId } from "../measurement/domain.ts";
import { activeHomepageSections, defaultHomepage, homepageInput, homepageLayers, scopeKey, type HomepageScope } from "./homepage-contract.ts";

export const defaultHomepageConfig = "shared-home-v1";

export async function readPublishedHomepage(db: DbReader, marketId: MarketId, locale: string, draftScopeKey?: string) {
  const keys = homepageLayers(marketId, locale).map(scopeKey);
  const records = await db.homepageContent.findMany({
    where: { key: { in: keys } },
    select: { key: true, draft: Boolean(draftScopeKey), published: { select: { id: true, content: true } } },
  });
  const byKey = new Map(records.map(row => [row.key, row]));
  const releaseIds: string[] = [];
  const layers = keys.flatMap(key => {
    const record = byKey.get(key);
    const draft = draftScopeKey === key;
    const parsed = homepageInput.safeParse(draft ? record?.draft : record?.published?.content);
    if (!parsed.success) return [];
    if (record?.published && !draft) releaseIds.push(record.published.id);
    return [parsed.data];
  });
  // Include the ordered set of contributing releases so changes to an inherited
  // layer change the identity of the exact storefront configuration.
  const measurement = releaseIds.length
    ? `home-release-${stableMeasurementId("homepage", marketId, locale, ...releaseIds).slice(0, 24)}`
    : defaultHomepageConfig;
  return { layers: [defaultHomepage, ...layers], measurement };
}

export const publishedHomepage = cache((marketId: MarketId, locale: string, draftScopeKey?: string) =>
  readPublishedHomepage(getDb(), marketId, locale, draftScopeKey));

export function previewMarketMatches(scope: HomepageScope, marketId: MarketId, locale: string) {
  return (!scope.marketId || marketId === scope.marketId) && (!scope.locale || locale === scope.locale);
}

export async function homepageMediaSources(sources: readonly string[], db: DbReader = getDb()) {
  const ids = [...new Set(sources.filter(source => /^\/media\/[a-f0-9]{64}$/.test(source)).map(source => source.slice(7)))];
  if (!ids.length) return new Set<string>();
  const rows = await db.catalogMedia.findMany({ where: { id: { in: ids }, editorial: true }, select: { id: true } });
  return new Set(rows.map(({ id }) => `/media/${id}`));
}

export async function isPublishedHomepageMedia(source: string, market: MarketConfiguration, at = new Date(), db: DbReader = getDb()) {
  const { layers } = await readPublishedHomepage(db, market.id, market.locale);
  return activeHomepageSections(layers, at, market.timeZone).some(section => section.bannerImage?.src === source) &&
    (await homepageMediaSources([source], db)).has(source);
}
