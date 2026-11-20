import type { MarketId } from "../../config/markets.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { canonicalCategoryLocale, catalogLocaleChain } from "./category-locale.ts";
import { resolveRecoveredCategoryId } from "./category-reference.ts";
import { departmentAncestorPath } from "./departments.ts";

export { canonicalCategoryLocale, catalogLocaleChain } from "./category-locale.ts";

export async function listCategoryPresentation(marketId: MarketId, locale: string, db: DbReader = getDb()) {
  const locales = catalogLocaleChain(locale);
  const rows = await db.department.findMany({
    where: { state: "ACTIVE" },
    select: {
      id: true, kind: true, parentId: true, slug: true, name: true, shortName: true, description: true,
      position: true, imageSrc: true, imageAlt: true,
      bannerSrc: true, bannerAlt: true, seoTitle: true, seoDescription: true,
      translations: { where: { locale: { in: locales } } },
      marketPresentations: { where: { marketId } },
    },
  });
  const departments = new Map(rows.map(row => [row.id, row]));
  const projected = rows.flatMap(row => {
    const path = departmentAncestorPath(departments, row.id);
    if (!path) return [];
    const exact = row.translations.find(item => item.locale === locales[0]);
    const translation = exact ?? row.translations.find(item => item.locale === locales[1]);
    const [market] = row.marketPresentations;
    return [{
      id: row.id, kind: row.kind, parentId: row.parentId, slug: row.slug,
      localizedSlug: exact?.slug ?? row.slug,
      name: translation?.name ?? row.name, shortName: translation?.shortName ?? row.shortName,
      contentLocale: translation?.locale ?? null,
      description: translation?.description ?? row.description, position: market?.position ?? row.position,
      image: { src: market?.imageSrc ?? row.imageSrc, alt: market?.imageAlt ?? row.imageAlt },
      banner: row.bannerSrc && row.bannerAlt ? { src: row.bannerSrc, alt: row.bannerAlt } : null,
      seoTitle: row.seoTitle ?? translation?.name ?? row.name,
      seoDescription: row.seoDescription ?? translation?.description ?? row.description,
      visibleInNavigation: path.every(node => node.marketPresentations[0]?.visibleInNavigation !== false),
    }];
  });
  return projected.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id, "en"));
}

export type CategoryPresentation = Awaited<ReturnType<typeof listCategoryPresentation>>[number];

export async function resolveCategorySlug(rawSlug: string, marketId: MarketId, locale: string, db: DbReader = getDb(),
  presented?: readonly CategoryPresentation[]) {
  const slug = rawSlug.trim().normalize("NFC").toLowerCase();
  if (!slug || slug.length > 120) return null;
  const localized = canonicalCategoryLocale(locale);
  const [canonical, translations, aliases, categories] = await Promise.all([
    db.department.findUnique({ where: { slug }, select: { id: true } }),
    localized ? db.departmentTranslation.findUnique({
      where: { locale_slug: { locale: localized, slug } }, select: { departmentId: true },
    }) : null,
    db.departmentSlugAlias.findMany({
      where: { slug, locale: { in: localized ? [localized, ""] : [""] } }, select: { locale: true, departmentId: true },
    }),
    presented ?? listCategoryPresentation(marketId, locale, db),
  ]);
  const globalAlias = aliases.find(alias => alias.locale === "");
  const localizedAlias = aliases.find(alias => alias.locale === localized);
  const id = canonical?.id ?? globalAlias?.departmentId ?? translations?.departmentId ?? localizedAlias?.departmentId;
  const category = categories.find(item => item.id === id);
  if (!category) return null;
  const preferredSlug = canonical || globalAlias ? category.slug : category.localizedSlug;
  return { category, redirectSlug: rawSlug !== preferredSlug ? preferredSlug : null };
}

export async function resolveCategoryReference(ref: string, marketId: MarketId, locale: string, db: DbReader = getDb(),
  presented?: readonly CategoryPresentation[]) {
  const categories = presented ?? await listCategoryPresentation(marketId, locale, db);
  const slug = await resolveCategorySlug(ref, marketId, locale, db, categories);
  if (slug) return slug;
  const mappedId = await resolveRecoveredCategoryId(ref, db);
  const category = mappedId && categories.find(row => row.id === mappedId);
  return category ? { category, redirectSlug: category.localizedSlug } : null;
}
