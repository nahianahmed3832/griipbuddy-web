import Link from "next/link";
import { ArrowRight, ArrowUpRight, Plus } from "lucide-react";
import { SellerEmpty, SellerPageHeader, SellerStatus } from "@/components/marketplace/seller-ui";
import { SignInGate } from "@/components/marketplace/session";
import { SellerMarkets, ShopForm } from "@/components/marketplace/seller";
import { ThreadLinks } from "@/components/marketplace/messages";
import { formatMoney } from "@/config/markets";
import { orderDate, orderLabels } from "@/lib/commerce/labels";
import { sellerBuyerThreads } from "@/lib/marketplace/buyer-support";
import { sellerOrderRange } from "@/lib/marketplace/seller-order-range";
import { sellerOrderPage } from "@/lib/marketplace/seller-orders";
import { sellerMarketAccess, sellerWorkspace } from "@/lib/marketplace/seller-workspace";
import { selectableMarkets } from "@/lib/market-config";
import { currentMarket } from "@/lib/market-server";

export const metadata = { title: "Shop Manager" };

export default async function SellerPage() {
  const { shopper, shop } = await sellerWorkspace();
  if (!shopper) return <div className="seller-entry">
    <SellerPageHeader title="Shop Manager" />
    <SignInGate>Sign in to open or manage your shop.</SignInGate>
  </div>;
  if (!shop) return <div className="seller-entry">
    <SellerPageHeader title="Create your shop" description="Enter the name, address and description of your shop." />
    <ShopForm/>
  </div>;

  const market = await currentMarket();
  const markets = selectableMarkets();
  const grants = new Map(shop.marketGrants.map(grant => [grant.marketId, grant.status]));
  const approved = shop.published && grants.get(market.id) === "APPROVED";
  const range = sellerOrderRange(undefined, undefined, new Date(), market.id);
  const [summary, inbox] = await Promise.all([
    range ? sellerOrderPage(shop.id, range, 1) : null,
    sellerBuyerThreads(shopper.id, market.id, shop.id),
  ]);
  const orderLink = `/seller/orders?market=${market.id}`;
  const listingLink = `/seller/listings?market=${market.id}`;
  const subtotal = summary?.merchandise.find(total => total.currency === market.currency)?.amountMinor ?? 0;
  const scope = `${market.name} · ${market.currency}`;

  return <>
    <SellerPageHeader title="Shop overview" description={`${shop.name} · ${scope}`} actions={<>
      {approved && <Link className="seller-button" prefetch={false} href={`/shops/${shop.slug}?market=${market.id}`}>
        View public shop <ArrowUpRight size={15} aria-hidden="true"/>
      </Link>}
      {approved && <Link className="seller-button seller-button-primary"
        href={`/seller/listings/new?market=${market.id}`} prefetch={false}><Plus size={16} aria-hidden="true"/> New listing</Link>}
    </>}/>
    {summary && range && <section aria-labelledby="seller-dashboard-metrics">
      <div className="seller-panel-heading">
        <div><h2 id="seller-dashboard-metrics">Last 30 market days</h2>
          <p className="seller-muted">{range.from} – {range.to} · {market.timeZone}</p></div>
      </div>
      <dl className="seller-metrics">
        <div><dt>Orders placed</dt><dd>{summary.placed}</dd><small>Orders with your items, excluding cancellations</small></div>
        <div><dt>Units ordered</dt><dd>{summary.units}</dd><small>Quantity across your placed order lines</small></div>
        <div><dt>Merchandise subtotal</dt><dd>{formatMoney(subtotal, market)} <small className="seller-metric-currency">{market.currency}</small></dd>
          <small>Your placed items before shipping, tax and statement adjustments</small></div>
      </dl>
    </section>}
    <div className="seller-grid">
      <section className="seller-panel" id="orders">
        <div className="seller-panel-heading"><div><h2>Recent orders</h2><p className="seller-muted">{scope} · Your order lines</p></div>
          <Link href={orderLink} className="seller-button" prefetch={false}>All orders <ArrowRight size={15} aria-hidden="true"/></Link>
        </div>
        {summary?.orders.length ? <ul className="seller-activity">{summary.orders.slice(0, 5).map(order => (
          <li key={order.id}>
            <div><strong><Link prefetch={false} href={`/seller/orders/${order.id}?market=${market.id}`}>{order.reference}</Link></strong>
              <small>{orderDate(order.createdAt, market.id)} · {orderLabels[order.status]}</small></div>
            <div className="seller-activity-value"><strong>{formatMoney(order.items.reduce((sum, line) => sum + line.lineTotalMinor, 0), market)}</strong>
              <small>{market.currency}</small></div>
          </li>
        ))}</ul> : <SellerEmpty title="No orders in this period">Orders for your shop appear here after checkout.</SellerEmpty>}
      </section>
      <section className="seller-panel" aria-labelledby="seller-market-summary">
        <div className="seller-panel-heading"><div><h2 id="seller-market-summary">Market access</h2>
          <p className="seller-muted">Order history stays available for your shop.</p></div></div>
        <div className="seller-market-summary">{markets.map(option => {
          const access = sellerMarketAccess(shop.published, grants.get(option.id));
          return <div key={option.id}><span><strong>{option.name}</strong><small>{option.currency}</small></span>
            <SellerStatus tone={access.tone}>{access.label}</SellerStatus></div>;
        })}</div>
        <div className="seller-panel-footer"><a href="#markets" className="seller-button">Manage market access</a></div>
      </section>
    </div>
    <div className="seller-grid">
      <section className="seller-panel" id="listings">
        <div className="seller-panel-heading"><div><h2>Products</h2><p className="seller-muted">Manage your listings and assigned offers.</p></div>
          <Link className="seller-button" href={listingLink} prefetch={false}>View products <ArrowRight size={15} aria-hidden="true"/></Link></div>
      </section>
      <section className="seller-panel" id="inbox">
        <div className="seller-panel-heading"><div><h2>Seller Hub</h2><p className="seller-muted">Messages for your shop</p></div></div>
        {inbox?.rows.length ? <ThreadLinks rows={inbox?.rows ?? []} market={market.id} /> : <SellerEmpty title="No conversations yet" />}
      </section>
    </div>
    <section className="seller-panel" id="markets">
      <div className="seller-panel-heading"><h2>Selling markets</h2></div>
      <SellerMarkets grants={shop.marketGrants} markets={markets}/>
    </section>
    <section className="seller-panel" id="settings">
      <div className="seller-panel-heading"><h2>Shop settings</h2></div><ShopForm shop={shop}/>
    </section>
  </>;
}
