import Link from "next/link";
import type { Market } from "@/config/markets";
import type { StorefrontNavigation } from "@/lib/catalog/storefront-navigation";
import { store } from "@/config/store";
import { MarketPicker } from "./market-picker";
import { Wordmark } from "./wordmark";
import { MeasurementPreferences } from "./measurement-preferences";
import { OrderTrackingLink } from "./order-tracking-link";
import { selectableMarkets } from "@/lib/market-config";

export function SiteFooter({ navigation, market, production, clarityEnabled }: {
  navigation: StorefrontNavigation; market: Market; production: boolean; clarityEnabled: boolean;
}) {
  return (
    <footer className="site-footer">
      <div className="shell">
        <div className="site-footer__grid">
          <div className="site-footer__brand">
            <Wordmark />
            <p>{store.description}</p>
          </div>
          <nav aria-label="Footer departments">
            <h2>Departments</h2>
            {navigation.links.flatMap(link => link.category ? [
              <Link key={link.id} href={link.href} prefetch={false}>{link.label}</Link>,
            ] : [])}
          </nav>
          <nav aria-label="Footer collections">
            <h2>Discover</h2>
            <Link href="/shop">Shop all</Link>
            {!production && <>
              <Link href="/collections/new-arrivals">New arrivals</Link>
              <Link href="/collections/featured">Featured picks</Link>
            </>}
            <Link href="/cart">Your cart</Link>
          </nav>
          <div>
            <h2>Support</h2>
            <OrderTrackingLink href="/orders/track">Track your order</OrderTrackingLink>
            {store.supportEmail && <a href={`mailto:${store.supportEmail}`}>{store.supportEmail}</a>}
            {store.policies.map((policy) => <Link key={policy.href} href={policy.href}>{policy.label}</Link>)}
          </div>
        </div>
        <div className="site-footer__bottom">
          <MarketPicker market={market} options={selectableMarkets()} />
          <span>{production ? store.name : store.previewNotice}</span>
        </div>
        {(production ? process.env.ACQUISITION_MEASUREMENT === "1" : true) && <MeasurementPreferences marketId={market.id} clarityEnabled={clarityEnabled} />}
      </div>
    </footer>
  );
}
