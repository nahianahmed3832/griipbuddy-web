import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { SellerPreparationForm } from "@/components/marketplace/seller-preparation-form";
import { SignInGate } from "@/components/marketplace/session";
import { formatMoney, markets } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { fulfillmentLabels, orderDate, orderLabels } from "@/lib/commerce/labels";
import { getShopper } from "@/lib/marketplace/auth";
import { sellerOrderRange } from "@/lib/marketplace/seller-order-range";
import { sellerOrderPage, sellerShop } from "@/lib/marketplace/seller-orders";
import { nextSellerPreparation, sellerPaymentAllowsPreparation, sellerPreparationLabels } from "@/lib/marketplace/seller-preparation";
import { marketplaceMode } from "@/lib/release-config";

export const metadata = { title: "Shop orders" };

export default async function SellerOrdersPage({ searchParams }: {
  searchParams: Promise<{ from?: string | string[]; to?: string | string[]; page?: string | string[] }>;
}) {
  if (!marketplaceMode()) notFound();
  const shopper = await getShopper();
  if (!shopper) {
    return <div className="shell mp-page"><h1 className="mp-page-title">Shop orders</h1><SignInGate>Sign in to manage shop orders.</SignInGate></div>;
  }
  const shop = await sellerShop(shopper.id);
  if (!shop) redirect("/seller");

  const query = await searchParams;
  const range = sellerOrderRange(query.from, query.to);
  const enteredPage = typeof query.page === "string" && /^\d{1,8}$/u.test(query.page) ? Number(query.page) : 1;
  const page = Math.max(1, enteredPage);
  const result = range ? await sellerOrderPage(shop.id, range, page) : null;
  const dates = range ? new URLSearchParams({ from: range.from, to: range.to }).toString() : "";

  return (
    <div className="shell mp-page">
      <nav className="mp-panel-links" aria-label="Shop navigation">
        <Link href="/seller" prefetch={false}>Shop Manager</Link>
      </nav>
      <h1 className="mp-page-title">Shop orders</h1>
      <p>{shop.name}</p>
      <form action={storefrontPath("/seller/orders")} method="get" className="mp-inline" aria-label="Filter orders by date">
        <label>From <input name="from" type="date" min="1970-01-01" defaultValue={range?.from ?? (typeof query.from === "string" ? query.from : "")} /></label>
        <label>To <input name="to" type="date" min="1970-01-01" defaultValue={range?.to ?? (typeof query.to === "string" ? query.to : "")} /></label>
        <button type="submit" className="button button--outline">Apply dates</button>
        {range && <a className="button button--outline" href={storefrontPath(`/api/marketplace/seller/orders.csv?${dates}`)} download>Download CSV</a>}
        {!range && <p role="alert">Choose a valid date range. The From date must be on or before the To date.</p>}
      </form>
      {result && <>
        <p className="mp-lead">Order dates use Bangladesh time.</p>
        <dl className="mp-shop-grid" aria-label="Shop order totals">
          <div className="mp-list-card"><dt>Orders placed</dt><dd><strong>{result.placed}</strong></dd></div>
          <div className="mp-list-card"><dt>Units sold</dt><dd><strong>{result.units}</strong></dd></div>
          <div className="mp-list-card">
            <dt>Merchandise subtotal</dt>
            <dd>{result.merchandise.length ? result.merchandise.map(total => (
              <strong key={total.currency}>{formatMoney(total.amountMinor, total.currency === "USD" ? markets.us : markets.bd)} {total.currency}</strong>
            )) : <strong>0</strong>}</dd>
          </div>
        </dl>
        <section className="mp-section">
          <h2>Orders in this period</h2>
          {result.orders.length === 0 ? <p>No orders on this page.</p> : <ul className="mp-shop-grid">
            {result.orders.map(order => {
              const preparation = order.sellerFulfillments[0];
              const next = sellerPaymentAllowsPreparation(order.payment)
                ? nextSellerPreparation(order.status, order.fulfillmentStatus, preparation?.status ?? null)
                : null;
              const market = markets[order.marketId];
              return <li key={order.id} className="mp-list-card">
                <h3><strong>{order.reference}</strong></h3>
                <p>{orderDate(order.createdAt)} · {orderLabels[order.status]}</p>
                <ul>
                  {order.items.map(line => <li key={line.id}>
                    <p>{line.quantity} × {line.productName}</p>
                    <p>{line.variantName} · {line.sku} · {formatMoney(line.lineTotalMinor, market)}</p>
                    {line.personalization && <p>Personalization: {line.personalization}</p>}
                  </li>)}
                </ul>
                {order.status === "PLACED" && <p>GriipBuddy delivery: {fulfillmentLabels[order.fulfillmentStatus]}</p>}
                <p>Shop preparation: {preparation ? sellerPreparationLabels[preparation.status] : "Awaiting preparation"}</p>
                {preparation && <p>Updated {orderDate(preparation.updatedAt)}</p>}
                {next && <SellerPreparationForm orderId={order.id} next={next} />}
              </li>;
            })}
          </ul>}
          {(page > 1 || result.hasNext) && <nav className="mp-panel-links" aria-label="Order pages">
            {page > 1 && <Link prefetch={false} href={`/seller/orders?${dates}&page=${page - 1}`}>Previous page</Link>}
            <span aria-current="page">Page {page}</span>
            {result.hasNext && <Link prefetch={false} href={`/seller/orders?${dates}&page=${page + 1}`}>Next page</Link>}
          </nav>}
        </section>
      </>}
    </div>
  );
}
