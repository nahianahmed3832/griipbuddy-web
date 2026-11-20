import { isDeepStrictEqual } from "node:util";
import type { MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { localMarketTime } from "../market-calendar.ts";
import { marketConfiguration } from "../market-config.ts";
import { editorialInput, editorialKey, emptyEditorial, type EditorialContent } from "../catalog/editorial-contract.ts";
import { homepageTileUploadSources } from "../catalog/homepage-content.ts";
import { missingImage } from "./catalog-media.ts";
import { canEditHomepage } from "./homepage.ts";
import { CatalogWriteError } from "./operation-error.ts";

export type EditorialScope = { marketId: MarketId; locale: string };

async function requireAccess(db: DbReader, actorId: string, scope: EditorialScope) {
  if (!await canEditHomepage(actorId, scope, db)) throw new CatalogWriteError("forbidden", "This editorial scope is unavailable.");
}

async function validateEditorial(db: DbReader, scope: EditorialScope, content: EditorialContent, published: EditorialContent) {
  const market = marketConfiguration(scope.marketId);
  const previous = new Map(published.documents.map(item => [item.id, item]));
  for (const item of content.documents) {
    if ([item.startsLocal, item.endsLocal].some(value => value && !localMarketTime(value, market.timeZone))) {
      throw new CatalogWriteError("invalid_input", `The schedule for “${item.title}” uses an invalid local time.`);
    }
    const original = previous.get(item.id);
    if (original && (original.slug !== item.slug || original.kind !== item.kind)) {
      throw new CatalogWriteError("invalid_input", "Keep the public URL of a published document stable.");
    }
  }
  const sources = [...new Set(content.documents.flatMap(item => item.image ? [item.image.src] : []))];
  const hosted = sources.filter(source => source.startsWith("/media/"));
  const builtIn = sources.filter(source => !source.startsWith("/media/"));
  const [approved, missing] = await Promise.all([
    homepageTileUploadSources(hosted, scope.marketId, scope.locale, db),
    missingImage(db, builtIn),
  ]);
  if (missing || hosted.some(source => !approved.has(source))) {
    throw new CatalogWriteError("invalid_input", "Choose an approved editorial image from this market and language.");
  }
}

export async function editorialEditor(actorId: string, scope: EditorialScope) {
  const db = getDb();
  await requireAccess(db, actorId, scope);
  const key = editorialKey(scope.marketId, scope.locale);
  const row = await db.homepageContent.findUnique({ where: { key }, select: {
    revision: true, draft: true, publishedId: true, published: { select: { content: true } },
    history: { orderBy: { publishedAt: "desc" }, take: 12, select: { id: true, publishedAt: true } },
  } });
  return {
    revision: row?.revision ?? 0, publishedId: row?.publishedId ?? null, hasDraft: Boolean(row),
    draft: editorialInput.safeParse(row?.draft).data ?? emptyEditorial,
    history: row?.history ?? [],
  };
}

export async function updateEditorial(actorId: string, scope: EditorialScope, expectedRevision: number,
  command: "save" | "publish" | "withdraw", source?: EditorialContent) {
  const key = editorialKey(scope.marketId, scope.locale);
  return getDb().$transaction(async tx => {
    await requireAccess(tx, actorId, scope);
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${key}), 42)`;
    const row = await tx.homepageContent.findUnique({ where: { key }, select: {
      revision: true, draft: true, publishedId: true, published: { select: { content: true } },
    } });
    if ((row?.revision ?? 0) !== expectedRevision) throw new CatalogWriteError("conflict", "This editorial draft changed. Reload it and try again.");
    const published = editorialInput.safeParse(row?.published?.content).data ?? emptyEditorial;
    const revision = expectedRevision + 1;
    let publishedId = row?.publishedId ?? null;
    if (command === "withdraw") {
      if (!publishedId) throw new CatalogWriteError("not_found", "This editorial scope has no live publication.");
      await tx.homepageContent.update({ where: { key }, data: { publishedId: null, revision } });
      publishedId = null;
    } else {
      const content = command === "save" ? source : editorialInput.safeParse(row?.draft).data;
      if (!content) throw new CatalogWriteError("invalid_input", "Save a valid editorial draft first.");
      await validateEditorial(tx, scope, content, published);
      const draft = content satisfies Prisma.InputJsonValue;
      if (command === "save") {
        await tx.homepageContent.upsert({ where: { key },
          create: { key, ...scope, draft }, update: { revision, draft } });
      } else {
        if (publishedId && isDeepStrictEqual(content, published)) return { revision: expectedRevision, publishedId };
        const release = await tx.homepageRelease.create({ data: { actorId, scopeKey: key, content: draft }, select: { id: true } });
        await tx.homepageContent.update({ where: { key }, data: { revision, publishedId: release.id } });
        publishedId = release.id;
      }
    }
    await tx.auditEvent.create({ data: { action: "MERCHANDISING_REVIEW", actorId, target: key, changes: {
      step: `editorial-${command}`, revision, publishedId, previousReleaseId: row?.publishedId ?? null,
    } } });
    return { revision, publishedId };
  });
}
