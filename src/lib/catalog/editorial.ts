import { cache } from "react";
import type { MarketId } from "../../config/markets.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { marketConfiguration } from "../market-config.ts";
import { homepageTileUploadSources } from "./homepage-content.ts";
import { visibleHomepageSection } from "./homepage-contract.ts";
import { catalogBrowseHref } from "./catalog-browse-href.ts";
import { editorialInput, editorialKey, emptyEditorial, type EditorialContent, type EditorialDocument } from "./editorial-contract.ts";

export async function readPublishedEditorial(db: DbReader, marketId: MarketId, locale: string, at = new Date()): Promise<EditorialContent> {
  const market = marketConfiguration(marketId);
  if (!market.languages.includes(locale)) return emptyEditorial;
  const row = await db.homepageContent.findUnique({
    where: { key: editorialKey(marketId, locale) },
    select: { published: { select: { content: true } } },
  });
  const parsed = editorialInput.safeParse(row?.published?.content);
  if (!parsed.success) return emptyEditorial;
  const active = parsed.data.documents.filter(item => visibleHomepageSection(item, at, market.timeZone));
  const hosted = active.flatMap(item => item.image?.src.startsWith("/media/") ? [item.image.src] : []);
  const approved = hosted.length ? await homepageTileUploadSources(hosted, marketId, locale, db) : new Set<string>();
  return {
    categories: parsed.data.categories,
    documents: active.map(item => item.image?.src.startsWith("/media/") && !approved.has(item.image.src)
      ? { ...item, image: undefined } : item),
  };
}

export const publishedEditorial = cache((marketId: MarketId, locale: string) => readPublishedEditorial(getDb(), marketId, locale));
export const editorialPath = (document: Pick<EditorialDocument, "kind" | "slug">) =>
  `/${document.kind === "ARTICLE" ? "blog" : "pages"}/${document.slug}`;

export function editorialImageSource(document: EditorialDocument, marketId: MarketId, locale: string) {
  const src = document.image?.src;
  if (!src || !src.startsWith("/media/")) return src;
  return `${src}?${new URLSearchParams({ market: marketId, lang: locale })}`;
}

export async function editorialSitemapPaths(db: DbReader, scopes: readonly { id: MarketId; locales: readonly string[] }[], at = new Date()) {
  const sets = await Promise.all(scopes.flatMap(({ id, locales }) => locales.map(async locale => {
    const { documents } = await readPublishedEditorial(db, id, locale, at);
    const scoped = { id, locale, regional: false };
    return [
      ...(documents.some(document => document.kind === "ARTICLE") ? [catalogBrowseHref("/blog", scoped)] : []),
      ...documents.map(document => catalogBrowseHref(editorialPath(document), scoped)),
    ];
  })));
  return sets.flat();
}
