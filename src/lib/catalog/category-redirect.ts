import type { MarketId } from "../../config/markets.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { canonicalCategoryLocale, resolveCategoryReference } from "./category-presentation.ts";
import { recoveredCategoryId } from "./category-reference.ts";

export async function resolveDepartmentRedirect(raw: string, marketId: MarketId, locale: string, db: DbReader = getDb()) {
  const slug = raw.normalize("NFC").toLowerCase();
  if (slug.length > 120 || !/^[\p{L}\p{N}][\p{L}\p{M}\p{N}-]*$/u.test(slug)) return null;
  const localized = canonicalCategoryLocale(locale);
  const alias = await db.department.findFirst({
    where: { state: "ACTIVE", OR: [
      { slugAliases: { some: { slug, locale: { in: localized ? [localized, ""] : [""] } } } },
      ...(localized ? [{ translations: { some: { slug, locale: localized } } }] : []),
    ] }, select: { id: true },
  });
  if (!alias && !recoveredCategoryId.test(raw)) return null;
  return (await resolveCategoryReference(raw, marketId, locale, db))?.redirectSlug ?? null;
}
