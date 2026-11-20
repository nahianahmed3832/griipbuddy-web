import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { SellerEmpty, SellerPageHeader, SellerPager, SellerStatus } from "@/components/marketplace/seller-ui";
import { SignInGate } from "@/components/marketplace/session";
import { caseProgressLabel } from "@/components/marketplace/case-panels";
import { storefrontPath } from "@/config/storefront-path";
import { orderDate } from "@/lib/commerce/labels";
import { currentMarket } from "@/lib/market-server";
import { activeCaseStatuses, caseKindLabels } from "@/lib/marketplace/case-policy";
import { sellerCasePage } from "@/lib/marketplace/seller-cases";
import { sellerWorkspace } from "@/lib/marketplace/seller-workspace";

export const metadata = { title: "Shop after-sales requests", robots: { index: false, follow: false } };

type QueryValue = string | string[] | undefined;

export default async function SellerCases({ searchParams }: {
  searchParams: Promise<{ market?: QueryValue; q?: QueryValue; state?: QueryValue; page?: QueryValue }>;
}) {
  const { shopper, shop } = await sellerWorkspace();
  if (!shopper) return <div className="seller-entry"><SellerPageHeader title="After-sales requests"/><SignInGate>
    Sign in to see requests for your shop.
  </SignInGate></div>;
  if (!shop) redirect("/seller");
  const [query, market] = await Promise.all([searchParams, currentMarket()]);
  if (query.market !== undefined && query.market !== market.id) notFound();
  const q = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
  const all = query.state === "all";
  const page = typeof query.page === "string" && /^\d{1,6}$/u.test(query.page) ? Math.max(1, Number(query.page)) : 1;
  const { rows, hasNext } = await sellerCasePage(shop.id, market.id, page, { q, all });
  const filter = new URLSearchParams({ market: market.id, ...(q && { q }), ...(all && { state: "all" }) });

  return <>
    <SellerPageHeader title="After-sales requests" description={`${shop.name} · ${market.name} · ${market.currency}`}
      actions={<Link href={`/seller/orders?market=${market.id}`} className="seller-button" prefetch={false}>Back to orders</Link>}/>
    <section className="seller-panel" aria-labelledby="seller-after-sales-list">
      <div className="seller-panel-heading"><div>
        <h2 id="seller-after-sales-list">Requests for your items</h2>
        <p className="seller-muted">Marketplace review, returns and cancellations linked to your purchased lines.</p>
      </div></div>
      <form className="seller-filters seller-product-filters" method="get" action={storefrontPath("/seller/cases")} aria-label="Filter after-sales requests">
        <input type="hidden" name="market" value={market.id}/>
        <label>Order reference<input type="search" name="q" defaultValue={q} maxLength={100}/></label>
        <label>Requests<select name="state" defaultValue={all ? "all" : "open"}>
          <option value="open">Open requests</option><option value="all">All requests</option>
        </select></label>
        <button type="submit" className="seller-button seller-button-primary">Apply filters</button>
      </form>
      {!rows.length ? <SellerEmpty title="No matching requests">Try another order reference or include completed requests.</SellerEmpty>
        : <div className="seller-table-wrap"><table className="seller-table" aria-labelledby="seller-after-sales-list">
          <thead><tr><th scope="col">Order</th><th scope="col">Request</th><th scope="col">Your units</th>
            <th scope="col">Status</th><th scope="col">Updated</th><th scope="col">Details</th></tr></thead>
          <tbody>{rows.map(row => <tr key={row.id}>
            <td data-label="Order"><Link prefetch={false} href={`/seller/orders/${row.order.id}?market=${market.id}`}>{row.order.reference}</Link></td>
            <td data-label="Request"><span>{caseKindLabels[row.kind]}</span></td>
            <td data-label="Your units"><span>{row.returnLines.reduce((total, item) => total + item.quantity, 0)}</span></td>
            <td data-label="Status"><SellerStatus tone={activeCaseStatuses.some(status => status === row.status) ? "warning" : "muted"}>
              {caseProgressLabel(row.kind, row.status)}
            </SellerStatus></td>
            <td data-label="Updated"><span>{orderDate(row.updatedAt, market.id)}</span></td>
            <td data-label="Details"><Link href={`/seller/cases/${row.id}?market=${market.id}`} prefetch={false} className="seller-table-action">
              View request <ChevronRight aria-hidden="true" size={14}/><span className="seller-visually-hidden"> for order {row.order.reference}</span>
            </Link></td>
          </tr>)}</tbody>
        </table></div>}
      <SellerPager label="After-sales pages" page={page} hasNext={hasNext} pageHref={number => `/seller/cases?${filter}&page=${number}`}/>
    </section>
  </>;
}
