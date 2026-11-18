import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import type { ReactNode } from "react";
import "@fontsource-variable/manrope";
import "./globals.css";
import "./marketplace.css";
import { CartPricingProvider } from "@/components/cart-pricing";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { Wordmark } from "@/components/wordmark";
import { demoAccount, store } from "@/config/store";
import { globalAccountRequestHeader } from "@/config/regional-path";
import { catalog } from "@/lib/catalog/repository";
import { currentMarket } from "@/lib/market-server";
import { firstPartyStoreMode, hybridDemoMode, marketplaceMode, productionMode } from "@/lib/release-config";
import { currentAccountLanguage, marketAccountProfile } from "@/lib/marketplace/account-language-server";
import { getShopper } from "@/lib/marketplace/auth";
import { shopperIdentityDirectory, storefrontHandoffUrl } from "@/lib/marketplace/identity-directory";
import { shopperSelections } from "@/lib/marketplace/data";
import { MarketplaceSession } from "@/components/marketplace/session";
import { MarketplaceFooter, MarketplaceHeader } from "@/components/marketplace/chrome";
import { shopperMailAvailable, shopperMailPreview } from "@/lib/commerce/shopper-mail";

export const metadata: Metadata = {
  title: { default: `${store.name} — Shop by department`, template: `%s · ${store.name}` },
  description: store.description,
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // The catalog is runtime data. Building an image must not require a database.
  await connection();
  const [market, cookieStore, requestHeaders] = await Promise.all([currentMarket(), cookies(), headers()]);
  const signedIn = cookieStore.get(demoAccount.cookie)?.value === "1";
  const marketplace = marketplaceMode();
  const hybrid = hybridDemoMode();
  const directory = marketplace ? shopperIdentityDirectory() : null;
  const handoffStart = directory?.localMarket && directory.current !== directory.issuer
    ? storefrontHandoffUrl("start", directory.current, { market: directory.localMarket }).href : undefined;
  const globalAccount = requestHeaders.has(globalAccountRequestHeader);
  const [departments, shopper, language] = await Promise.all([
    globalAccount ? [] : catalog.listDepartments(hybrid ? market.id : undefined),
    marketplace ? globalAccount ? getShopper().catch(() => null) : getShopper() : null,
    marketplace && !globalAccount ? currentAccountLanguage(market.id) : "en" as const,
  ]);
  const [selections, profile] = shopper && !globalAccount
    ? await Promise.all([shopperSelections(shopper.id, market.id), marketAccountProfile(shopper.id, market.id)])
    : [{ favorites: [], lists: [], shops: [] }, null];
  const main = <main id="main-content" tabIndex={-1}>{children}</main>;
  return (
    <html lang={store.language}>
      <body className={marketplace ? "marketplace" : undefined} data-market={hybrid ? market.id : undefined}>
        <a className="skip-link" href="#main-content">Skip to content</a>
        <CartPricingProvider market={market} regionalRouting={hybrid}>
          {marketplace ? <MarketplaceSession key={shopper?.id ?? "guest"} shopper={shopper && { id: shopper.id, name: profile?.displayName ?? shopper.name }}
            selections={selections} hybrid={hybrid} marketId={market.id} language={language} emailLinks={shopperMailAvailable()}
            emailPreview={shopperMailPreview()} handoffStart={globalAccount ? undefined : handoffStart}>
            {hybrid ? <div className="preview-strip">Dev store · Sample orders and prices</div>
              : firstPartyStoreMode() && market.id === "us" && <div className="preview-strip">US preview prices and shipping are for testing.</div>}
            {globalAccount ? <header className="shell site-header__row"><Wordmark href="/global-account" /></header>
              : <MarketplaceHeader departments={departments} market={market} />}
            {main}
            {!globalAccount && <MarketplaceFooter market={market} regionalRouting={hybrid} />}
          </MarketplaceSession> : <>
            <SiteHeader departments={departments} signedIn={signedIn} production={productionMode()} />
            {main}
            <SiteFooter departments={departments} market={market} production={productionMode()} />
          </>}
        </CartPricingProvider>
      </body>
    </html>
  );
}
