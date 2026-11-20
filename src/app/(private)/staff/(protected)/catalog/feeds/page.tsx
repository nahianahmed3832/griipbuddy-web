import Link from "next/link";
import { notFound } from "next/navigation";
import { formatMoney, isMarketId } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { devLiveBangladeshFeed } from "@/lib/catalog/merchant-feed-config";
import { fixtureFeedExportEnabled, loadFixtureFeedSelection, maxSelectedVariants } from "@/lib/catalog/merchant-feed-export";
import { metaFeedConditions } from "@/lib/catalog/merchant-feed";
import { loadMerchantFeed } from "@/lib/catalog/merchant-feed-service";
import { requireStaff } from "@/lib/staff/access";
import { staffMarketIds } from "@/lib/staff/market-access";
import { marketConfiguration } from "@/lib/market-config";
import "./feeds.css";

export const metadata = { title: "Catalog feeds", robots: { index: false, follow: false } };

const pageSize = 30;
const issueLabels: Record<string, string> = {
  demo: "This staging sample is excluded from the feed.",
  missing_brand: "Confirm the merchandise manufacturer’s brand.",
  missing_description: "Add a product description.",
  missing_image: "Add a product or variant image.",
  invalid_offer: "Check the variant’s price, currency, and stock for this market.",
  missing_identifiers: "Add the manufacturer-assigned GTIN or part number, or confirm that neither was assigned.",
  invalid_gtin: "Check the GTIN format and check digit against the manufacturer’s identifier.",
  conflicting_identifiers: "Resolve the conflict between an identifier and the confirmation that none was assigned.",
  missing_gtin: "A manufacturer part number is recorded. Add the GTIN if one was assigned.",
  variant_group: "Review the size, color, or other variant dimensions before grouping these offers.",
  live_unverified: "The live Bangladesh offer could not be verified. Check the variant, photo, price, and stock before submission.",
};

export default async function CatalogFeeds({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [staff, params] = await Promise.all([requireStaff(), searchParams]);
  if (staff.role !== "OWNER") notFound();
  const allowed = await staffMarketIds(staff.id, "commercial");
  const requested = params.market;
  if (!allowed.length || (requested !== undefined && (!isMarketId(requested) || !allowed.includes(requested)))) notFound();
  const market = marketConfiguration(requested ?? allowed[0]);
  const canExport = fixtureFeedExportEnabled(market.id);
  const result = await (canExport ? loadFixtureFeedSelection(market.id) : loadMerchantFeed(market.id)).catch(() => null);
  if (!result) return <section className="commerce-panel"><h1>Catalog feeds</h1>
    <p>The feed is temporarily unavailable. Reload to retry the catalog check.</p></section>;
  const { items, issues } = result;
  const excluded = new Set(issues.filter(issue => issue.severity === "excluded").map(issue => issue.variantId));
  const review = new Set(issues.filter(issue => issue.severity === "review").map(issue => issue.variantId));
  const lastPage = Math.max(1, Math.ceil(issues.length / pageSize));
  const exportPages = Math.max(1, Math.ceil(items.length / maxSelectedVariants));
  const pageNumber = (value: string | string[] | undefined, last: number) => typeof value === "string" && /^\d{1,6}$/.test(value)
    ? Math.min(last, Math.max(1, Number(value))) : 1;
  const page = pageNumber(params.page, lastPage);
  const exportPage = pageNumber(params.exportPage, exportPages);
  const pageHref = (target: number, selected = exportPage) => `/staff/catalog/feeds?market=${market.id}&page=${target}&exportPage=${selected}`;
  const pageItems = items.slice((exportPage - 1) * maxSelectedVariants, exportPage * maxSelectedVariants);

  return <>
    <div className="commerce-intro staff-order-heading">
      <div><h1 className="display-type">Catalog feeds</h1><p>Review variant data for {market.name}.</p></div>
      <a className="button button--outline" href={storefrontPath(`/feeds/${market.id}.xml`)}>Open public Google XML</a>
    </div>
    <nav className="staff-filters" aria-label="Feed markets">
      {allowed.map(id => <Link key={id} href={`/staff/catalog/feeds?market=${id}`}
        aria-current={id === market.id ? "page" : undefined}>{marketConfiguration(id).name}</Link>)}
    </nav>
    <section className="commerce-panel commerce-summary mb-4" aria-labelledby="feed-summary">
      <h2 id="feed-summary">Feed validation</h2>
      <dl>
        <div><dt>Variants in XML</dt><dd>{items.length}</dd></div>
        <div><dt>Excluded variants</dt><dd>{excluded.size}</dd></div>
        <div><dt>Variants to review</dt><dd>{review.size}</dd></div>
      </dl>
      <p className="commerce-muted">{market.id === "bd" && devLiveBangladeshFeed()
        ? "The feed checks current Bangladesh prices and stock against the live store. Preview listings use the dev product page."
        : "These checks use the same market catalog as the XML feed. Merchant Center runs its own checks when a feed is submitted."}</p>
    </section>
    <section className="commerce-panel commerce-stack" aria-labelledby="feed-export">
      <h2 id="feed-export">Development export</h2>
      <p>Download selected native offers as Google or Meta XML. Upload and account synchronization are separate provider actions.</p>
      {!canExport ? <p>This workspace requires a native staging-market development fixture.</p> : !pageItems.length
        ? <p>No eligible offers have verified native stock and required catalog fields.</p>
        : <form action={storefrontPath("/api/staff/catalog/feed-export")} method="post" className="commerce-form">
          <input type="hidden" name="market" value={market.id} />
          <input type="hidden" name="currency" value={market.currency} />
          <fieldset className="feed-picker">
            <legend>Offers on page {exportPage} of {exportPages}</legend>
            {pageItems.map(item => <label key={item.variantId}>
              <input type="checkbox" name="variant" value={item.variantId} />
              <span>{item.title} · {formatMoney(item.amountMinor, market)} · {item.availability === "in_stock" ? "In stock" : "Out of stock"}</span>
            </label>)}
          </fieldset>
          <label>Condition for all selected Meta offers<select name="condition" defaultValue="">
            <option value="">Choose condition for Meta</option>
            {metaFeedConditions.map(value => <option key={value} value={value}>{value[0].toUpperCase() + value.slice(1)}</option>)}
          </select></label>
          <div className="commerce-fields">
            <button type="submit" name="channel" value="google" className="button button--outline">Download Google XML</button>
            <button type="submit" name="channel" value="meta" className="button button--outline">Download Meta XML</button>
          </div>
        </form>}
      {canExport && exportPages > 1 && <nav className="staff-filters" aria-label="Export offer pages">
        {exportPage > 1 && <Link href={pageHref(page, exportPage - 1)}>Previous offers</Link>}
        {exportPage < exportPages && <Link href={pageHref(page, exportPage + 1)}>Next offers</Link>}
      </nav>}
    </section>
    {issues.length > 0 ? <ul className="staff-orders" aria-label="Feed issues">
      {issues.slice((page - 1) * pageSize, page * pageSize).map(issue => <li
        className="commerce-panel staff-order-row" key={`${issue.variantId}/${issue.code}`}
      >
        <div><Link className="staff-order-ref" href={`/staff/catalog/products/${encodeURIComponent(issue.productId)}`}>{issue.productName}</Link>
          <p className="wrap-anywhere">{issue.variantId}</p></div>
        <p>{issueLabels[issue.code] ?? issue.code.replaceAll("_", " ")}</p>
        <span className="staff-status">{issue.severity === "excluded" ? "Excluded" : "Review"}</span>
      </li>)}
    </ul> : <p className="commerce-panel">No feed issues found in this market.</p>}
    {lastPage > 1 && <nav className="staff-filters" aria-label="Feed issue pages">
      {page > 1 && <Link href={pageHref(page - 1)}>Previous page</Link>}
      <span>Page {page} of {lastPage}</span>
      {page < lastPage && <Link href={pageHref(page + 1)}>Next page</Link>}
    </nav>}
  </>;
}
