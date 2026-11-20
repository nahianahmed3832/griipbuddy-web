import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs, EmptyState } from "@/components/store-ui";
import styles from "@/components/product-discovery.module.css";
import { catalogBrowseHref } from "@/lib/catalog/category-browse-links";
import { catalogVariantWhere } from "@/lib/catalog/connected-public";
import { getDb } from "@/lib/db/client";
import { currentMarket } from "@/lib/market-server";
import { hybridDemoMode } from "@/lib/release-config";

export const metadata: Metadata = { title: "Shop by brand" };

export default async function BrandsPage() {
  const market = await currentMarket();
  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  const rows = await getDb().product.groupBy({
    by: ["brand"], where: { brand: { not: null }, variants: { some: catalogVariantWhere(market.id) } }, orderBy: { brand: "asc" },
  });
  const labels = new Map<string, string>();
  for (const { brand } of rows) if (brand) labels.set(brand.normalize("NFKC").toLowerCase(), brand);
  const brands = [...labels].sort((a, b) => a[1].localeCompare(b[1], market.locale));
  const shop = catalogBrowseHref("/shop", context);
  return <div className="shell inner-page">
    <Breadcrumbs items={[{ label: "Shop", href: shop }, { label: "Brands" }]} />
    <h1 className="display-type">Shop by brand</h1>
    {brands.length ? <ul className={styles.brandGrid}>{brands.map(([value, label]) => <li key={value}>
      <Link href={catalogBrowseHref("/shop", context, new URLSearchParams({ brand: value }))} prefetch={false}>{label}</Link>
    </li>)}</ul> : <EmptyState title="No brands listed" description="You can still browse available products.">
      <Link href={shop} className="button button--primary">Browse products</Link>
    </EmptyState>}
  </div>;
}
