import Link from "next/link";
import { notFound } from "next/navigation";
import { getMarket, marketList } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { devLiveBangladeshFeed } from "@/lib/catalog/merchant-feed-config";
import { loadMerchantFeed } from "@/lib/catalog/merchant-feed-service";
import { requireStaff } from "@/lib/staff/access";

export const metadata = { title: "Google Shopping feeds" };

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

export default async function GoogleShoppingFeeds({ searchParams }: {
  searchParams: Promise<{ market?: string; page?: string }>;
}) {
  const [staff, params] = await Promise.all([requireStaff(), searchParams]);
  if (staff.role !== "OWNER") notFound();
  const market = getMarket(params.market);
  const result = await loadMerchantFeed(market.id).catch(() => null);
  if (!result) return <section className="commerce-panel"><h1>Google Shopping feeds</h1>
    <p>The feed is temporarily unavailable. Reload to retry the catalog check.</p></section>;
  const { items, issues } = result;
  const excluded = new Set(issues.filter(issue => issue.severity === "excluded").map(issue => issue.variantId));
  const review = new Set(issues.filter(issue => issue.severity === "review").map(issue => issue.variantId));
  const lastPage = Math.max(1, Math.ceil(issues.length / pageSize));
  const page = /^\d{1,4}$/.test(params.page ?? "") ? Math.min(lastPage, Math.max(1, Number(params.page))) : 1;
  const pageHref = (target: number) => `/staff/catalog/feeds?market=${market.id}&page=${target}`;

  return <>
    <div className="commerce-intro staff-order-heading">
      <div><h1 className="display-type">Google Shopping feeds</h1><p>Review variant data for {market.name}.</p></div>
      <a className="button button--outline" href={storefrontPath(`/feeds/${market.id}.xml`)}>Open XML feed</a>
    </div>
    <nav className="staff-filters" aria-label="Feed markets">
      {marketList.map(choice => <Link key={choice.id} href={`/staff/catalog/feeds?market=${choice.id}`}
        aria-current={choice.id === market.id ? "page" : undefined}>{choice.name}</Link>)}
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
