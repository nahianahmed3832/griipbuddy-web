import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { connection } from "next/server";
import { Suspense, type ReactNode } from "react";
import "@fontsource-variable/manrope";
import "@/app/globals.css";
import "@/app/marketplace.css";
import { CartPricingProvider } from "@/components/cart-pricing";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { demoAccount, store } from "@/config/store";
import { storefrontNavigation } from "@/lib/catalog/storefront-navigation";
import { catalogBrowseHref } from "@/lib/catalog/category-browse-links";
import { reportFailure } from "@/lib/db/observability";
import { currentMarket } from "@/lib/market-server";
import { hybridDemoMode, marketplaceMode, productionMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { shopperSelections } from "@/lib/marketplace/data";
import { MarketplaceSession } from "@/components/marketplace/session";
import { MarketplaceFooter, MarketplaceHeader } from "@/components/marketplace/chrome";
import { ClarityReplay } from "@/components/clarity-replay";
import { MeasurementAccountAssociation } from "@/components/measurement-observers";
import { clarityProject } from "@/lib/measurement/clarity-config";
import { hasStaffMeasurementSession } from "@/lib/measurement/server";

export const storeMetadata: Metadata = {
  title: { default: `${store.name} — Shop by department`, template: `%s · ${store.name}` },
  description: store.description,
};

export async function StorefrontDocument({ children, browse = false }: Readonly<{ children: ReactNode; browse?: boolean }>) {
  // The catalog is runtime data. Building an image must not require a database.
  await connection();
  const [market, cookieStore] = await Promise.all([currentMarket(), cookies()]);
  const signedIn = cookieStore.get(demoAccount.cookie)?.value === "1";
  const marketplace = marketplaceMode();
  const hybrid = hybridDemoMode();
  const [navigation, shopper] = await Promise.all([
    storefrontNavigation(market).catch(error => {
      reportFailure("catalog.navigation", undefined, error);
      return { managed: false, links: [{ id: "shop", label: "Shop all",
        href: catalogBrowseHref("/shop", { id: market.id, locale: market.locale, regional: hybrid }) }] };
    }),
    marketplace ? getShopper() : null,
  ]);
  const selections = shopper ? await shopperSelections(shopper.id, market.id) : { favorites: [], lists: [], shops: [] };
  const project = clarityProject(market);
  const staff = project && hasStaffMeasurementSession(await headers());
  const replayEligible = !shopper && !signedIn && !staff;
  const main = <main id="main-content" tabIndex={-1}>{children}</main>;
  return (
    <html lang={market.locale}>
      <body className={marketplace ? "marketplace" : undefined} data-market={market.id}
        data-clarity-mask={browse ? "true" : undefined}>
        {browse && <Suspense fallback={null}>
          <ClarityReplay project={project} marketId={market.id} eligible={replayEligible} />
        </Suspense>}
        {marketplace && <MeasurementAccountAssociation marketId={market.id} signedIn={Boolean(shopper)} />}
        <a className="skip-link" href="#main-content">Skip to content</a>
        <CartPricingProvider market={market} shopperId={shopper?.id}>
          {marketplace ? <MarketplaceSession key={shopper?.id ?? "guest"} shopper={shopper && { id: shopper.id, name: shopper.name }} selections={selections} hybrid={hybrid}>
            {market.status === "staging" && <div className="preview-strip">{market.name} staging · Sample orders and prices</div>}
            <MarketplaceHeader navigation={navigation} market={market} />
            {main}
            <MarketplaceFooter market={market} clarityEnabled={Boolean(project)} />
          </MarketplaceSession> : <>
            <SiteHeader navigation={navigation} market={market} signedIn={signedIn} production={productionMode()} />
            {main}
            <SiteFooter navigation={navigation} market={market} production={productionMode()} clarityEnabled={Boolean(project)} />
          </>}
        </CartPricingProvider>
      </body>
    </html>
  );
}
