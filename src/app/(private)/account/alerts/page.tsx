import Link from "next/link";
import { notFound } from "next/navigation";
import { SignInGate } from "@/components/marketplace/session";
import { RefreshVariantAlerts, VariantWatchForm, WatchedProductLink } from "@/components/marketplace/variant-watch";
import { formatMoney, markets, type MarketId } from "@/config/markets";
import { localizedStorePath } from "@/config/regional-path";
import { currentMarket } from "@/lib/market-server";
import { getShopper } from "@/lib/marketplace/auth";
import { evaluateVariantWatches } from "@/lib/marketplace/variant-watches";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";

export const metadata = { title: "Product alerts" };

function watchProductHref(slug: string, variantId: string, marketId: MarketId, regional: boolean) {
  const path = `/products/${slug}`;
  const params = new URLSearchParams({ variant: variantId, market: marketId });
  return `${regional ? localizedStorePath(path, marketId) : path}?${params}`;
}

export default async function AccountAlertsPage() {
  if (!marketplaceMode()) notFound();
  const shopper = await getShopper();
  const heading = <h1 className="mp-page-title">Product alerts</h1>;
  if (!shopper) return <div className="shell mp-page">{heading}<SignInGate>Sign in to see your product alerts.</SignInGate></div>;

  const [{ watches, events }, activeMarket] = await Promise.all([evaluateVariantWatches(shopper.id), currentMarket()]);
  const regional = hybridDemoMode();
  function productLink(watch: Pick<(typeof watches)[number], "variant" | "variantId" | "marketId">) {
    return <WatchedProductLink title={watch.variant.product.name} marketId={watch.marketId}
      switchMarket={!regional && activeMarket.id !== watch.marketId}
      href={watchProductHref(watch.variant.product.slug, watch.variantId, watch.marketId, regional)} />;
  }

  return <div className="shell mp-page">
    {heading}
    <nav className="mp-panel-links" aria-label="Account sections"><Link href="/account">Account settings</Link></nav>
    <section className="mp-section" aria-labelledby="latest-product-alerts">
      <h2 id="latest-product-alerts">Latest alerts</h2>
      <p>Opening this page checks the current price and stock for your watched variants.</p>
      <RefreshVariantAlerts />
      {events.length ? <ul className="mp-shop-grid">
        {events.map(event => {
          const market = markets[event.watch.marketId];
          return <li className="mp-list-card" key={event.id}>
            <h3>{event.kind === "BACK_IN_STOCK" ? "Back in stock" : "Price drop"}</h3>
            {productLink(event.watch)}
            <p>{event.watch.variant.label} · {market.name}</p>
            {event.amountMinor !== null && <p>{event.previousAmountMinor !== null && <><del>{formatMoney(event.previousAmountMinor, market)}</del>{" "}</>}
              <strong>{formatMoney(event.amountMinor, market)}</strong>
            </p>}
            <time dateTime={event.createdAt.toISOString()}>{new Intl.DateTimeFormat(market.locale, { dateStyle: "medium", timeZone: "UTC" }).format(event.createdAt)}</time>
          </li>;
        })}
      </ul> : <p>No product alerts yet.</p>}
    </section>
    <section className="mp-section" aria-labelledby="watched-product-variants">
      <h2 id="watched-product-variants">Watched variants</h2>
      {watches.length ? <ul className="mp-shop-grid">
        {watches.map(watch => <li className="mp-list-card" key={watch.id}>
          <h3>{productLink(watch)}</h3>
          <p>{watch.variant.label} · {markets[watch.marketId].name}</p>
          <VariantWatchForm shopperId={shopper.id} variantId={watch.variantId} marketId={watch.marketId}
            options={{ backInStock: watch.backInStock, priceDrop: watch.priceDrop }} />
        </li>)}
      </ul> : <p>Choose a variant on a product page to turn on alerts.</p>}
    </section>
  </div>;
}
