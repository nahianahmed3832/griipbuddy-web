import { getDb, type DbReader } from "../db/client.ts";
import { marketIds } from "../../config/markets.ts";
import { isMarketSelectable, marketConfiguration } from "../market-config.ts";
import { homepageMediaSources, readPublishedHomepage } from "../catalog/homepage-content.ts";
import { availableMarketEditorialMedia } from "../catalog/repository.ts";
import { activeHomepageSections, scopeKey, type HomepageScope } from "../catalog/homepage-contract.ts";
import { encodeCatalogImage, missingImage } from "./catalog-media.ts";
import { canEditHomepage } from "./homepage.ts";
import { CatalogWriteError } from "./operation-error.ts";

const mediaId = /^\/media\/([a-f0-9]{64})$/;
const uploadTarget = (id: string) => `homepage-media:${id}`;
const uploadStep = "homepage-image-uploaded";

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
    db.auditEvent.findMany({ where: { target: { in: ids.map(uploadTarget) }, action: "MERCHANDISING_REVIEW",
      AND: [{ changes: { path: ["step"], equals: uploadStep } }, ...(scope.marketId ?
        [{ changes: { path: ["marketId"], equals: scope.marketId } }] : [])] },
      distinct: ["target"], select: { target: true } }),
    Promise.all(markets.map(marketId => availableMarketEditorialMedia(hosted, marketId, db))),
    Promise.all(markets.flatMap(marketId => {
      const market = marketConfiguration(marketId);
      return market.languages.filter(locale => !scope.locale || scope.locale === locale).map(async locale => {
        const { layers } = await readPublishedHomepage(db, marketId, locale);
        return activeHomepageSections(layers, new Date(), market.timeZone).flatMap(({ bannerImage }) =>
          bannerImage && hosted.includes(bannerImage.src) ? [bannerImage.src] : []);
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
    await tx.auditEvent.create({ data: { action: "MERCHANDISING_REVIEW", actorId, target: uploadTarget(image.id),
      changes: { step: uploadStep, marketId: scope.marketId ?? null, scope: scopeKey(scope) } } });
    return { src: `/media/${image.id}` };
  });
}
