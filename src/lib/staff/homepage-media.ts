import { getDb, type DbReader } from "../db/client.ts";
import { marketIds } from "../../config/markets.ts";
import { isMarketSelectable, marketConfiguration } from "../market-config.ts";
import { homepageMediaSources, homepageTileUploadSources, homepageUploadStep, homepageUploadTarget, readPublishedHomepage } from "../catalog/homepage-content.ts";
import { availableMarketEditorialMedia } from "../catalog/repository.ts";
import { activeHomepageSections, homepageTileImages, scopeKey, type HomepageScope } from "../catalog/homepage-contract.ts";
import { encodeCatalogImage, missingImage } from "./catalog-media.ts";
import { canEditHomepage } from "./homepage.ts";
import { CatalogWriteError } from "./operation-error.ts";

const mediaId = /^\/media\/([a-f0-9]{64})$/;

export async function homepageAllowedMedia(db: DbReader, scope: HomepageScope, sources: readonly string[]) {
  const allowed = new Set<string>();
  const { hosted, builtIn } = [...new Set(sources)].reduce((groups, src) => {
    (mediaId.test(src) ? groups.hosted : groups.builtIn).push(src);
    return groups;
  }, { hosted: [] as string[], builtIn: [] as string[] });
  for (const src of builtIn) if (!await missingImage(db, [src])) allowed.add(src);
  if (!hosted.length) return allowed;

  const ids = hosted.map(src => src.slice(7));
  const markets = scope.marketId ? [scope.marketId] : marketIds.filter(isMarketSelectable);
  const [uploads, catalog, published] = await Promise.all([
    db.auditEvent.findMany({ where: { target: { in: ids.map(homepageUploadTarget) }, action: "MERCHANDISING_REVIEW",
      AND: [{ changes: { path: ["step"], equals: homepageUploadStep } }, ...(scope.marketId ?
        [{ changes: { path: ["marketId"], equals: scope.marketId } }] : [])] },
      distinct: ["target"], select: { target: true } }),
    Promise.all(markets.map(marketId => availableMarketEditorialMedia(hosted, marketId, db))),
    Promise.all(markets.flatMap(marketId => {
      const market = marketConfiguration(marketId);
      return market.languages.filter(locale => !scope.locale || scope.locale === locale).map(async locale => {
        const { layers } = await readPublishedHomepage(db, marketId, locale);
        const sections = activeHomepageSections(layers, new Date(), market.timeZone);
        const sources = sections.flatMap(section => homepageTileImages(section).map(image => image.src)).filter(src => hosted.includes(src));
        const tiles = await homepageTileUploadSources(sources, marketId, locale, db);
        const legacy = sections.flatMap(({ type, bannerImage }) =>
          type !== "TILES" && bannerImage && hosted.includes(bannerImage.src) ? [bannerImage.src] : []);
        return [...tiles, ...legacy];
      });
    })),
  ]);
  const uploaded = uploads.map(({ target }) => target.replace(/^homepage-media:/, "/media/"));
  for (const src of await homepageMediaSources([...uploaded, ...published.flat()], db)) allowed.add(src);
  for (const paths of catalog) for (const src of paths) allowed.add(src);
  return allowed;
}

export async function storeHomepageImage(actorId: string, scope: HomepageScope, bytes: Buffer, contentType: string) {
  const db = getDb();
  if (!await canEditHomepage(actorId, scope, db)) throw new CatalogWriteError("forbidden", "Homepage media access is unavailable.");
  const image = await encodeCatalogImage(bytes, contentType);
  return db.$transaction(async tx => {
    if (!await canEditHomepage(actorId, scope, tx)) throw new CatalogWriteError("forbidden", "Homepage media access is unavailable.");
    await tx.catalogMedia.upsert({ where: { id: image.id }, update: { editorial: true }, create: { ...image, editorial: true } });
    await tx.auditEvent.create({ data: { action: "MERCHANDISING_REVIEW", actorId, target: homepageUploadTarget(image.id),
      changes: { step: homepageUploadStep, marketId: scope.marketId ?? null, scope: scopeKey(scope) } } });
    return { src: `/media/${image.id}` };
  });
}
