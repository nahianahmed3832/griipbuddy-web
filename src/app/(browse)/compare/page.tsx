import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Breadcrumbs, EmptyState } from "@/components/store-ui";
import { RestoreComparison, UpdateComparison } from "@/components/product-comparison";
import styles from "@/components/product-discovery.module.css";
import { formatMoney } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { catalogBrowseHref, catalogProductHref } from "@/lib/catalog/category-browse-links";
import { comparisonProducts } from "@/lib/catalog/comparison";
import { getConnectedProduct } from "@/lib/catalog/connected-product";
import { CatalogApiError } from "@/lib/catalog/connected-public";
import type { SearchParams } from "@/lib/catalog/listing";
import { currentMarket } from "@/lib/market-server";
import { hybridDemoMode } from "@/lib/release-config";

export const metadata: Metadata = { title: "Compare products", robots: { index: false, follow: true } };

export default async function ComparePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const [market, raw] = await Promise.all([currentMarket(), searchParams]);
  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  const selected = comparisonProducts(typeof raw.product === "string" ? [raw.product] : raw.product);
  const available = await Promise.all(selected.map(async ref => {
    const data = await getConnectedProduct(ref, { marketId: market.id, locale: market.locale }).catch(error => {
      if (error instanceof CatalogApiError && ["invalid_product", "product_variant_limit"].includes(error.code)) return null;
      throw error;
    });
    if (!data) return null;
    const variant = data.variants.find(item => item.id === data.defaultVariantId && item.offer.eligible)
      ?? data.variants.find(item => item.offer.eligible);
    if (!variant) return null;
    return { ref, data, variant };
  }));
  const rows = available.filter(row => row !== null);
  const specifications = [...new Set(rows.flatMap(row => row.data.product.specifications.map(spec => spec.label)))].slice(0, 20);
  const browse = catalogBrowseHref("/shop", context);
  return <div className="shell inner-page">
    <Breadcrumbs items={[{ label: "Compare products" }]} />
    <h1 className="display-type">Compare products</h1>
    {rows.length ? <>
      {rows.length < selected.length && <p role="status">An item in this comparison is unavailable in {market.name}.</p>}
      <div className={styles.actions}>
        <Link href={browse} className="button button--outline">Browse more products</Link>
        <UpdateComparison market={context} products={selected} />
      </div>
      <div className={styles.comparison} role="region" tabIndex={0} aria-label="Product comparison table">
        <table>
          <caption className="sr-only">Product prices and specifications in {market.name}</caption>
          <thead><tr><th scope="col">Product</th>{rows.map(({ ref, data, variant }) => {
            const image = variant.image ?? data.product.images[0];
            return <th key={ref} scope="col">
              <Link className={styles.compareProduct} href={catalogProductHref({ slug: data.product.slug,
                matchedVariantId: variant.id, knownOptions: [] }, context)} prefetch={false}>
                {image && <Image src={storefrontPath(image.src)} alt="" width={112} height={112} />}
                {data.product.name}
              </Link>
              <UpdateComparison market={context} products={selected} remove={ref} name={data.product.name} />
            </th>;
          })}</tr></thead>
          <tbody>
            <tr><th scope="row">Shown option</th>{rows.map(({ ref, variant }) => <td key={ref}>
              {variant.options.map(option => option.valueLabel).join(" / ") || variant.label || variant.sku}</td>)}</tr>
            <tr><th scope="row">Current price</th>{rows.map(({ ref, variant }) => <td key={ref}>
              {formatMoney(variant.offer.amountMinor, market)}</td>)}</tr>
            <tr><th scope="row">Brand</th>{rows.map(({ ref, data }) => <td key={ref}>{data.product.brand || "Not specified"}</td>)}</tr>
            {specifications.map(label => <tr key={label}><th scope="row">{label}</th>{rows.map(({ ref, data }) => <td key={ref}>
              {data.product.specifications.find(spec => spec.label === label)?.value ?? "Not specified"}</td>)}</tr>)}
          </tbody>
        </table>
      </div>
      <p>Open a product to check delivery and availability for its options.</p>
    </> : <EmptyState title={selected.length ? "Products unavailable here" : "Your comparison is empty"}
      description={selected.length ? `These items are unavailable in ${market.name}.` : "Add products from their detail pages to compare options and current prices."}>
      <Link className="button button--primary" href={browse}>Browse products</Link>
      {!selected.length && <RestoreComparison market={context} />}
      {selected.length > 0 && <UpdateComparison market={context} products={selected} />}
    </EmptyState>}
  </div>;
}
