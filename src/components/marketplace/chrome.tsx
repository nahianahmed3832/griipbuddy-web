import Link from "next/link";
import { ArrowUpRight, Headphones, Heart, PackageCheck, Truck, Undo2 } from "lucide-react";
import { Suspense } from "react";
import type { Market } from "@/config/markets";
import { store } from "@/config/store";
import type { StorefrontNavigation } from "@/lib/catalog/storefront-navigation";
import { hybridStoreMode } from "@/lib/release-config";
import { selectableMarkets } from "@/lib/market-config";
import { CartLink } from "../cart-link";
import { MarketPicker } from "../market-picker";
import { MeasurementPreferences } from "../measurement-preferences";
import { HeaderSearch, SearchForm } from "../search-form";
import { Wordmark } from "../wordmark";
import { ShopperMenu } from "./session";
import { MobileStoreNav, StoreCategoryMenu, StoreNavigationBar } from "./store-navigation";
import "./store-navigation.css";
import "./merchandising.css";

export function MarketplaceHeader({ navigation, market }: { navigation: StorefrontNavigation; market: Market }) {
  const hybrid = hybridStoreMode();
  const scope = hybrid ? "marketplace" : "store";
  return (
    <header className="site-header mp-header mp-store-header" data-market={market.id}>
      <div className="shell site-header__row mp-header-row">
        <Wordmark />
        <StoreCategoryMenu navigation={navigation} marketId={market.id} />
        <div className="site-header__search">
          <Suspense fallback={<SearchForm market={market} scope={scope} />}><HeaderSearch market={market} scope={scope} /></Suspense>
        </div>
        <div className="mp-header-actions">
          <ShopperMenu />
          <Link className="mp-icon mp-header-saved" href="/favorites" aria-label="Saved items" title="Saved items">
            <Heart size={22} aria-hidden="true" />
          </Link>
          <CartLink />
        </div>
      </div>
      <StoreNavigationBar navigation={navigation} marketId={market.id} className="shell mp-nav" label="Shop navigation" />
    </header>
  );
}

const shoppingHelp = [
  { label: "Delivery & payment", icon: Truck, href: "/help/delivery" },
  { label: "Track an order", icon: PackageCheck, href: "/orders" },
  { label: "Returns & refunds", icon: Undo2, href: "/help/returns" },
  { label: "Customer support", icon: Headphones, href: "/help" },
] as const;

export function MarketplaceFooter({ market, clarityEnabled = false }: {
  market: Market; clarityEnabled?: boolean;
}) {
  return (
    <footer className="mp-store-footer">
      <nav className="mp-store-footer-guide" aria-label="Shopping help">
        <ul className="shell">
          {shoppingHelp.map(({ href, label, icon: Icon }) => (
            <li key={href}>
              <Link href={href}>
                <Icon size={22} strokeWidth={1.7} aria-hidden="true" />
                <span>{label}</span>
                <ArrowUpRight size={15} strokeWidth={1.7} aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="shell mp-store-footer-content">
        <div className="mp-store-footer-brand">
          <Wordmark />
          <a href={`mailto:${store.supportEmail}`}>{store.supportEmail}</a>
        </div>
        <nav className="mp-store-footer-links" aria-label="Shop">
          <h2>Shop</h2>
          <Link href="/shop">Shop all</Link>
          <Link href="/shop?sort=newest">New arrivals</Link>
          <Link href="/shop?offer=sale">Deals</Link>
          <Link href="/favorites">Saved items</Link>
        </nav>
        <nav className="mp-store-footer-links" aria-label="Orders and help">
          <h2>Orders &amp; Help</h2>
          <Link href="/orders">Order status</Link>
          <Link href="/help/delivery">Delivery &amp; payment</Link>
          <Link href="/help/returns">Returns &amp; refunds</Link>
          <Link href="/help">Help Center</Link>
        </nav>
        <nav className="mp-store-footer-links" aria-label="About">
          <h2>About</h2>
          <Link href="/help/terms">Terms of use</Link>
          <Link href="/help/privacy">Privacy</Link>
          {hybridStoreMode() && <Link href="/seller">Seller portal</Link>}
        </nav>
      </div>
      <div className="mp-store-footer-base">
        <div className="shell mp-store-footer-meta">
          <MarketPicker market={market} options={selectableMarkets()} marketplace />
          <small>© {new Date().getFullYear()} GriipBuddy</small>
        </div>
        <div className="shell"><MeasurementPreferences marketId={market.id} clarityEnabled={clarityEnabled} /></div>
      </div>
      <MobileStoreNav />
    </footer>
  );
}
