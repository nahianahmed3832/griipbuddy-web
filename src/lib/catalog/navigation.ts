import type { MarketId } from "../../config/markets.ts";
import type { MenuPage } from "../../generated/prisma/client.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { isMarketSelectable } from "../market-config.ts";
import { catalogLocaleChain, listCategoryPresentation, type CategoryPresentation } from "./category-presentation.ts";
import { publicCollectionScope } from "./collection-selection.ts";

const pages = {
  HOME: { href: "/", en: "Home", bn: "হোম", es: "Inicio" },
  SEARCH: { href: "/search", en: "Search", bn: "খুঁজুন", es: "Buscar" },
  SHOP: { href: "/shop", en: "Shop", bn: "কেনাকাটা", es: "Tienda" },
} satisfies Record<MenuPage, { href: string; en: string; bn: string; es: string }>;

export function marketMenuPages(locale: string) {
  const language = locale.toLowerCase().split("-")[0];
  const labelLanguage = language === "bn" || language === "es" ? language : "en";
  return (Object.keys(pages) as MenuPage[]).map(page => ({ page, href: pages[page].href, label: pages[page][labelLanguage] }));
}

export type MarketMenuLink = {
  position: number;
  label: string;
  href: string;
  target: { type: "category" | "collection"; id: string } | { type: "page"; page: MenuPage };
};

export async function readMarketMenu(marketId: MarketId, key: string, locale: string, db: DbReader = getDb(),
  presented?: readonly CategoryPresentation[]) {
  if (!isMarketSelectable(marketId)) return null;
  const locales = [...new Set([...catalogLocaleChain(locale), ""])];
  const menus = await db.marketMenu.findMany({
    where: { marketId, key, locale: { in: locales } },
    select: { id: true, revision: true, locale: true, items: {
      where: { visible: true, OR: [{ collectionId: null }, { collection: { is: publicCollectionScope(marketId) } }] },
      orderBy: { position: "asc" },
      select: { position: true, label: true, departmentId: true, collection: { select: { id: true, slug: true, name: true } }, page: true },
    } },
  });
  const menu = locales.map(candidate => menus.find(row => row.locale === candidate)).find(row => row !== undefined);
  if (!menu) return null;

  const categories = presented ?? (menu.items.some(item => item.departmentId)
    ? await listCategoryPresentation(marketId, locale, db)
    : []);
  const visibleCategories = new Map(categories.filter(category => category.visibleInNavigation).map(category => [category.id, category]));
  const pageLinks = new Map(marketMenuPages(locale).map(item => [item.page, item]));
  const items = menu.items.flatMap<MarketMenuLink>(({ position, label, departmentId, collection, page }) => {
    if (departmentId) {
      const category = visibleCategories.get(departmentId);
      if (!category) return [];
      return [{ position, target: { type: "category", id: category.id }, label: label ?? category.shortName,
        href: `/departments/${encodeURIComponent(category.localizedSlug)}` }];
    }
    if (collection) return [{ position, target: { type: "collection", id: collection.id }, label: label ?? collection.name,
      href: `/collections/${encodeURIComponent(collection.slug)}` }];
    if (!page) return [];
    const link = pageLinks.get(page)!;
    return [{ position, target: { type: "page", page }, href: link.href, label: label ?? link.label }];
  });

  return { id: menu.id, revision: menu.revision, items };
}
