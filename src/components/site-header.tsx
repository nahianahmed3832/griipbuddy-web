import Link from "next/link";
import { UserRound } from "lucide-react";
import { Suspense } from "react";
import type { Market } from "@/config/markets";
import { store } from "@/config/store";
import type { StorefrontNavigation } from "@/lib/catalog/storefront-navigation";
import { CartLink } from "./cart-link";
import { StoreCategoryMenu, StoreNavigationBar } from "./marketplace/store-navigation";
import { HeaderSearch, SearchForm } from "./search-form";
import { SignIn } from "./sign-in";
import { Wordmark } from "./wordmark";
import "./marketplace/store-navigation.css";

export function SiteHeader({ navigation, market, signedIn, production }: {
  navigation: StorefrontNavigation; market: Market; signedIn: boolean; production: boolean;
}) {
  return (
    <header className="site-header">
      {!production && <div className="preview-strip">{store.previewNotice}</div>}
      <div className="shell site-header__row">
        <Wordmark />
        <StoreCategoryMenu navigation={navigation} marketId={market.id} />
        <div className="site-header__search"><Suspense fallback={<SearchForm market={market} />}><HeaderSearch market={market} /></Suspense></div>
        {production ? <Link className="account-control__trigger" href="/orders" aria-label="Your orders"><UserRound size={17} aria-hidden="true" /> Orders</Link> : <SignIn signedIn={signedIn} />}
        <CartLink />
      </div>
      <StoreNavigationBar navigation={navigation} marketId={market.id} className="shell site-nav__items" label="Departments" />
    </header>
  );
}
