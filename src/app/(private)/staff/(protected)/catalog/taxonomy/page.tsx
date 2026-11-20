import Link from "next/link";
import { ArrowLeft, FolderTree, ListTree, PanelsTopLeft } from "lucide-react";
import { marketList } from "@/config/markets";
import { TaxonomyAssignments } from "@/components/taxonomy-assignments";
import { TaxonomyAttributes } from "@/components/taxonomy-attributes";
import { TaxonomyCategoryEditor } from "@/components/taxonomy-category-editor";
import { TaxonomyCollections } from "@/components/taxonomy-collections";
import { TaxonomyPendingChanges } from "@/components/taxonomy-controls";
import { TaxonomyMarketSelect } from "@/components/taxonomy-market-select";
import { TaxonomyNavigation } from "@/components/taxonomy-navigation";
import { TaxonomyTree } from "@/components/taxonomy-tree";
import { departmentAncestorPath } from "@/lib/catalog/departments";
import { getDb } from "@/lib/db/client";
import { isMarketSelectable } from "@/lib/market-config";
import { currentMarket } from "@/lib/market-server";
import { requireStaff } from "@/lib/staff/access";
import { staffMarketIds } from "@/lib/staff/market-access";
import { loadCollectionWorkspace, loadNavigationWorkspace } from "@/lib/staff/navigation-workspace";
import "./taxonomy.css";

const path = "/staff/catalog/taxonomy";
const tabs = [
  { key: "categories", name: "Categories", Icon: FolderTree, href: path },
  { key: "navigation", name: "Navigation", Icon: ListTree, href: `${path}?view=navigation` },
  { key: "collections", name: "Collections", Icon: PanelsTopLeft, href: `${path}?view=collections` },
] as const;

function value(input: string | string[] | undefined) {
  return typeof input === "string" && input.length <= 120 ? input : undefined;
}

export default async function TaxonomyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [staff, market, params] = await Promise.all([requireStaff(), currentMarket(), searchParams]);
  const marketIds = await staffMarketIds(staff.id, "merchandising");
  const owner = staff.role === "OWNER";
  const markets = marketList.filter(item => marketIds.includes(item.id) && isMarketSelectable(item.id))
    .map(({ id, name }) => ({ id, name }));
  const canWork = markets.some(({ id }) => id === market.id);
  const view = tabs.find(tab => tab.key === value(params.view))?.key ?? "categories";
  const selected = value(params.category);
  const db = getDb();

  const [rows, nav, collections] = await Promise.all([
    canWork && view === "categories" ? db.department.findMany({
      orderBy: [{ position: "asc" }, { id: "asc" }],
      select: { id: true, name: true, slug: true, kind: true, parentId: true, state: true, position: true, revision: true,
        marketPresentations: { where: { marketId: market.id }, select: { visibleInNavigation: true } } },
    }) : [],
    canWork && view === "navigation" ? loadNavigationWorkspace(staff.id, market.id, value(params.menuKey), value(params.menuLocale)) : null,
    canWork && view === "collections" ? loadCollectionWorkspace(staff.id, market.id, value(params.collection)) : null,
  ]);

  const byId = new Map(rows.map(row => [row.id, row]));
  const categories = rows.map(({ marketPresentations, ...row }) => ({ ...row,
    visibleInNavigation: (marketPresentations[0]?.visibleInNavigation ?? true) &&
      Boolean(departmentAncestorPath(byId, row.id)?.every(item => item.marketPresentations[0]?.visibleInNavigation !== false)),
  }));
  const categoryId = selected ?? categories.find(row => row.kind && row.state === "ACTIVE")?.id ?? categories[0]?.id;
  const creating = selected === "new" && owner;
  const categoryRow = categoryId && categoryId !== "new" && categories.some(row => row.id === categoryId)
    ? await db.department.findUnique({ where: { id: categoryId }, include: {
      translations: { orderBy: { locale: "asc" } },
      marketPresentations: { where: { marketId: market.id } },
      slugAliases: { orderBy: [{ locale: "asc" }, { slug: "asc" }] },
    } }) : null;
  const category = categoryRow ? { ...categoryRow, aliases: categoryRow.slugAliases } : null;
  const mobileView = selected ? "editor" : "tree";

  return <TaxonomyPendingChanges>
    <div className="taxonomy-workspace">
      <header className="taxonomy-heading">
        <div>
          {owner && <Link className="text-link" href="/staff/catalog">Product catalog</Link>}
          <h1 className="display-type">Catalog organization</h1>
          <p>Manage categories, market menus, and curated product groups.</p>
        </div>
        {!!markets.length && <TaxonomyMarketSelect markets={markets} selected={canWork ? market.id : undefined} />}
      </header>
      {!markets.length ? <section className="taxonomy-card" aria-labelledby="taxonomy-access">
        <h2 id="taxonomy-access">Catalog access is unavailable</h2>
        <p>Your staff account needs a merchandising grant to manage a market.</p>
      </section> : <>
        <nav className="taxonomy-tabs" aria-label="Catalog organization">
          {tabs.map(({ key, Icon, href, name }) => <Link key={key} href={href} prefetch={false}
            aria-current={view === key ? "page" : undefined}><Icon size={17} aria-hidden="true" /> {name}</Link>)}
        </nav>
        {!canWork ? <section className="taxonomy-card" aria-labelledby="choose-taxonomy-market">
          <h2 id="choose-taxonomy-market">Select a working market</h2>
          <p>Choose a market your staff account can manage to load its settings.</p>
        </section> : view === "navigation" && nav ? <TaxonomyNavigation key={`navigation:${market.id}:${nav.key}:${nav.locale}`} data={nav} /> :
          view === "collections" && collections ? <TaxonomyCollections key={`collections:${market.id}:${collections.current?.id ?? "new"}`}
            data={collections} /> :
          <div className="taxonomy-grid" data-mobile-view={mobileView}>
            <TaxonomyTree categories={categories} selected={category?.id} canManage={owner} />
            <div className="taxonomy-editor">
              <Link className="taxonomy-button taxonomy-back-mobile" href={path}><ArrowLeft size={16} aria-hidden="true" /> Category tree</Link>
              {!owner && <p className="taxonomy-muted">Shared categories are read-only. You can edit presentation for {market.name}.</p>}
              {category || creating ? <TaxonomyCategoryEditor key={`${category?.id ?? "new"}:${market.id}`}
                category={category} categories={categories} canManageShared={owner} canManageMarket={canWork}
                markets={markets} selectedMarket={market.id} languages={[...market.languages]} /> :
                <section className="taxonomy-card"><h2>{selected ? "Category unavailable" : "Choose a category"}</h2>
                  <p>{selected ? "Select another category from the tree." : "Select a category or create a department to get started."}</p>
                </section>}
              {category?.kind && owner && <>
                <TaxonomyAssignments key={`assignments:${category.id}`} categoryId={category.id} categoryName={category.name}
                  categories={categories} canEdit={category.state !== "ARCHIVED"} />
                <TaxonomyAttributes key={`attributes:${category.id}`} categoryId={category.id} categoryName={category.name}
                  revision={category.revision} canEdit={category.state !== "ARCHIVED"} />
              </>}
            </div>
          </div>}
      </>}
    </div>
  </TaxonomyPendingChanges>;
}
