import type { Market } from "../../config/markets.ts";
import { localizedStorePath } from "../../config/regional-path.ts";
import { getDb } from "../db/client.ts";
import { hybridDemoMode, hybridStoreMode, marketplaceMode, productionMode } from "../release-config.ts";
import { listCategoryPresentation, type CategoryPresentation } from "./category-presentation.ts";
import { catalogBrowseHref } from "./category-browse-links.ts";
import { departmentTree, type DepartmentNode } from "./departments.ts";
import { heroPhoto } from "./imagery.ts";
import { readMarketMenu } from "./navigation.ts";
import { availableMarketEditorialMedia, catalog, marketEditorialImage } from "./repository.ts";
import type { CatalogImage } from "./types.ts";

export type StorefrontCategoryLink = {
  id: string;
  href: string;
  canonicalHref: string;
  label: string;
  image: CatalogImage;
  children: StorefrontCategoryLink[];
};

export type StorefrontNavLink = {
  id: string;
  href: string;
  label: string;
  category?: StorefrontCategoryLink;
  sale?: boolean;
};

export type StorefrontNavigation = {
  links: StorefrontNavLink[];
  managed: boolean;
};

export async function storefrontNavigation(market: Market): Promise<StorefrontNavigation> {
  const db = getDb();
  const categories = await listCategoryPresentation(market.id, market.locale, db);
  const menu = await readMarketMenu(market.id, "main", market.locale, db, categories);
  const visible = categories.filter(category => category.visibleInNavigation);
  const legacy = !menu && visible.some(category => !category.kind)
    ? new Set((await catalog.listDepartments(market.id)).map(category => category.id))
    : new Set<string>();
  const navigable = menu ? visible : visible.filter(category => category.kind || legacy.has(category.id));
  const available = await availableMarketEditorialMedia(navigable.map(category => category.image.src), market.id, db);
  const regional = hybridDemoMode();
  const context = { id: market.id, locale: market.locale, regional };
  const marketLink = (href: string) => {
    const [pathname, query] = href.split("?");
    return catalogBrowseHref(pathname, context, new URLSearchParams(query));
  };
  const convert = (node: DepartmentNode<CategoryPresentation>): StorefrontCategoryLink => ({
    id: node.id,
    href: catalogBrowseHref(`/departments/${encodeURIComponent(node.localizedSlug)}`, context),
    canonicalHref: regional ? localizedStorePath(`/departments/${encodeURIComponent(node.slug)}`, market.id)
      : `/departments/${encodeURIComponent(node.slug)}`,
    label: node.shortName,
    image: marketEditorialImage(node.image, available, market.id) ?? heroPhoto,
    children: node.children.map(convert),
  });
  const tree = departmentTree(navigable).map(convert);
  const byId = new Map<string, StorefrontCategoryLink>();
  function index(nodes: StorefrontCategoryLink[]) {
    for (const node of nodes) {
      byId.set(node.id, node);
      index(node.children);
    }
  }
  index(tree);

  if (menu) return {
    managed: true,
    links: menu.items.map(item => {
      const category = item.target.type === "category" ? byId.get(item.target.id) : undefined;
      return { id: `menu-${item.position}`, href: category?.href ?? marketLink(item.href), label: item.label, category };
    }),
  };
  const shop = { id: "shop", href: marketLink("/shop"), label: "Shop all" };
  const roots = tree.map(category => ({ id: `category-${category.id}`, label: category.label, href: category.href, category }));
  if (!marketplaceMode()) {
    const arrivals = { id: "new", href: catalogBrowseHref("/collections/new-arrivals", context), label: "New arrivals" };
    return { managed: false, links: [...(productionMode() ? [] : [arrivals]), ...roots, shop] };
  }
  return { managed: false, links: [shop, { id: "new", href: marketLink("/shop?sort=newest"), label: "New arrivals" },
    { id: "deals", href: marketLink("/shop?offer=sale"), label: "Deals", sale: true }, ...roots,
    ...(hybridStoreMode() ? [{ id: "shops", href: marketLink("/shops"), label: "Shops" }] : []),
  ] };
}
