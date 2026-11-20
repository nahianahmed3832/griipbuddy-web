import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronRight, Download } from "lucide-react";
import { SellerEmpty, SellerPageHeader, SellerPager, SellerStatus } from "@/components/marketplace/seller-ui";
import { SignInGate } from "@/components/marketplace/session";
import { formatMoney } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { currentMarket } from "@/lib/market-server";
import { fulfillmentLabels, orderDate, orderLabels, paymentLabels } from "@/lib/commerce/labels";
import { sellerOrderRange } from "@/lib/marketplace/seller-order-range";
import { sellerOrderPage, sellerOrderWorkspace } from "@/lib/marketplace/seller-orders";
import { sellerPreparationLabels } from "@/lib/marketplace/seller-preparation";
import { sellerWorkspace } from "@/lib/marketplace/seller-workspace";

export const metadata = { title: "Shop orders" };

export default async function SellerOrdersPage({ searchParams }: {
  searchParams: Promise<{ from?: string | string[]; to?: string | string[]; page?: string | string[]; market?: string | string[]; shop?: string | string[] }>;
}) {
  const { shopper } = await sellerWorkspace();
  if (!shopper) return <div className="seller-entry">
    <SellerPageHeader title="Shop orders" /><SignInGate>Sign in to manage shop orders.</SignInGate>
  </div>;
  const [query, market] = await Promise.all([searchParams, currentMarket()]);
  if (query.market !== undefined && query.market !== market.id || Array.isArray(query.shop)) notFound();
  const shop = await sellerOrderWorkspace(shopper.id, market.id, query.shop);
  if (!shop) redirect("/seller");
  const range = sellerOrderRange(query.from, query.to, new Date(), market.id);
  const enteredPage = typeof query.page === "string" && /^\d{1,8}$/u.test(query.page) ? Number(query.page) : 1;
  const page = Math.max(1, enteredPage);
  const result = range ? await sellerOrderPage(shop.id, range, page) : null;
  const dates = range ? new URLSearchParams({ market: market.id, from: range.from, to: range.to, ...(!shop.owner && { shop: shop.id }) }).toString() : "";
  const subtotal = result?.merchandise.find(total => total.currency === market.currency)?.amountMinor ?? 0;

  return <>
    <SellerPageHeader title="Shop orders" description={`${shop.name} · ${market.name} · ${market.currency}`} actions={<>
      {shop.owner && <Link className="seller-button" href={`/seller/cases?market=${market.id}`} prefetch={false}>View after-sales requests</Link>}
      {range && shop.finance && <a className="seller-button" href={storefrontPath(`/api/marketplace/seller/orders.csv?${dates}`)} download>
        <Download size={16} aria-hidden="true"/> Download CSV
      </a>}
    </>}/>
    <section className="seller-panel" aria-label="Order filters">
      <form action={storefrontPath("/seller/orders")} method="get" className="seller-filters" aria-label="Filter orders by date">
        <input name="market" type="hidden" value={market.id}/>
        {!shop.owner && <input name="shop" type="hidden" value={shop.id}/>}
        <label>From <input name="from" type="date" min="1970-01-01" aria-invalid={!range}
          defaultValue={range?.from ?? (typeof query.from === "string" ? query.from : "")} />
        </label>
        <label>To <input name="to" type="date" min="1970-01-01" aria-invalid={!range}
          defaultValue={range?.to ?? (typeof query.to === "string" ? query.to : "")} />
        </label>
        <button type="submit" className="seller-button seller-button-primary">Apply filters</button>
      </form>
      {range ? <p className="seller-muted">Order dates use {market.timeZone}.</p>
        : <p className="seller-field-error" role="alert">Choose a valid date range. The From date must be on or before the To date.</p>}
    </section>
    {result && <>
      <dl className="seller-metrics" aria-label="Shop order totals for this market and date range">
        <div><dt>Orders placed</dt><dd>{result.placed}</dd><small>Orders with your items, excluding cancellations</small></div>
        <div><dt>Units ordered</dt><dd>{result.units}</dd><small>Quantity across your placed order lines</small></div>
        {shop.finance && <div><dt>Merchandise subtotal</dt><dd>{formatMoney(subtotal, market)} <small className="seller-metric-currency">{market.currency}</small></dd>
          <small>Your placed items before shipping, tax and statement adjustments</small></div>}
      </dl>
      <section className="seller-panel" aria-labelledby="seller-orders-list">
        <div className="seller-panel-heading"><div><h2 id="seller-orders-list">Orders in this period</h2>
          <p className="seller-muted">Newest first · Your shop’s order lines</p></div></div>
        {!result.orders.length ? <SellerEmpty title="No orders on this page">Change the date range or the active market to see more orders.</SellerEmpty>
          : <div className="seller-table-wrap"><table className="seller-table" aria-labelledby="seller-orders-list">
            <thead><tr><th scope="col">Order</th>{shop.finance && <th scope="col">Merchandise</th>}<th scope="col">Payment</th>
              <th scope="col">Fulfillment</th><th scope="col">Shop preparation</th><th scope="col">Details</th></tr></thead>
            <tbody>{result.orders.map(order => {
              const details = `/seller/orders/${order.id}?${dates}&page=${page}`;
              const total = order.items.reduce((sum, line) => sum + line.lineTotalMinor, 0);
              const units = order.items.reduce((sum, line) => sum + line.quantity, 0);
              const preparation = order.sellerFulfillments[0];
              const payment = order.payment?.currency === market.currency ? order.payment : null;
              return <tr key={order.id}>
                <td data-label="Order"><span><Link href={details} prefetch={false}>{order.reference}</Link>
                  <small>{orderDate(order.createdAt, market.id)} · {orderLabels[order.status]}</small></span></td>
                {shop.finance && <td data-label="Merchandise" data-money><span>{formatMoney(total, market)} {market.currency}<small>{units} {units === 1 ? "unit" : "units"}</small></span></td>}
                <td data-label="Payment"><span>{payment ? paymentLabels[payment.status] : "Unavailable"}</span></td>
                <td data-label="Fulfillment"><span>{order.status === "CANCELLED" ? "Cancelled" : fulfillmentLabels[order.fulfillmentStatus]}</span></td>
                <td data-label="Preparation"><span><SellerStatus tone={preparation?.status === "HANDED_OFF" ? "positive" : "muted"}>
                  {preparation ? sellerPreparationLabels[preparation.status] : "Awaiting preparation"}
                </SellerStatus></span></td>
                <td data-label="Details"><Link href={details} prefetch={false} className="seller-table-action">
                  Open <ChevronRight size={14} aria-hidden="true"/><span className="seller-visually-hidden"> order {order.reference}</span>
                </Link></td>
              </tr>;
            })}</tbody>
          </table></div>}
        <SellerPager label="Order pages" page={page} hasNext={result.hasNext} pageHref={number => `/seller/orders?${dates}&page=${number}`}/>
      </section>
    </>}
  </>;
}
