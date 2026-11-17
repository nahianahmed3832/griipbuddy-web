import { cookies, headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { SignInGate } from "@/components/marketplace/session";
import { marketDirectory, isStorefrontMarketId } from "@/config/markets";
import { countryHintHeader, marketStoreHref } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import { currentMarket } from "@/lib/market-server";
import { getShopper } from "@/lib/marketplace/auth";
import { chooseStorefrontHref, identityHomeHref, isHandoffMarket, preferredStoreCookie, shopperIdentityDirectory, storefrontHandoffUrl } from "@/lib/marketplace/identity-directory";
import { handoffToken } from "@/lib/marketplace/identity-handoff";
import { fixtureMarketEnabled, marketplaceMode } from "@/lib/release-config";
import "@/components/marketplace/customer-account.css";

export const metadata = { title: "GriipBuddy account", robots: { index: false, follow: false } };

export default async function GlobalAccount({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (!marketplaceMode()) notFound();
  const directory = shopperIdentityDirectory();
  if (directory && directory.current !== directory.issuer) redirect(identityHomeHref());
  const [cookieStore, requestHeaders, params, market, shopper] = await Promise.all([
    cookies(), headers(), searchParams, currentMarket(), getShopper().catch(() => undefined),
  ]);
  const showFixture = fixtureMarketEnabled();
  const preferred = cookieStore.get(preferredStoreCookie)?.value;
  const saved = isStorefrontMarketId(preferred, showFixture) ? preferred : null;
  const suggestion = requestHeaders.get(countryHintHeader) === "BD" ? "bd" : market.id;
  const markets = marketDirectory(showFixture);
  const first = markets.find(entry => entry.id === (saved ?? suggestion));
  const { market: requested, state, challenge, signin } = params;
  const parsedState = handoffToken.safeParse(state);
  const parsedChallenge = handoffToken.safeParse(challenge);
  const intent = directory && isHandoffMarket(requested) && parsedState.success && parsedChallenge.success
    ? { market: requested, state: parsedState.data, challenge: parsedChallenge.data } : null;
  const target = intent && markets.find(entry => entry.id === intent.market);
  const reset = storefrontPath(marketStoreHref("/account/reset-password", market.id));
  const settings = storefrontPath(marketStoreHref("/account/settings", market.id));

  return <div className="shell mp-page customer-account" aria-labelledby="global-account-heading">
    <header className="customer-account__intro">
      <h1 className="mp-page-title" id="global-account-heading">GriipBuddy account</h1>
      <p>Choose the country where you shop or where you placed an order.</p>
    </header>
    <section className="commerce-panel">
      <h2>{target ? `Sign in to ${target.name}` : "Sign-in and security"}</h2>
      {(shopper === undefined || signin === "unavailable") &&
        <p role="status">Sign-in is temporarily unavailable. Try again shortly. You can still reopen a country storefront.</p>}
      {shopper ? <>
        <p>Signed in as {shopper.name}</p>
        {intent && directory && <p><a className="button button--primary" href={storefrontHandoffUrl("authorize", directory.issuer, intent).href}>Continue to {target?.name}</a></p>}
        <a href={settings}>Security settings</a>
      </> : <SignInGate>Use your GriipBuddy login in each country storefront.</SignInGate>}
      <p><a href={reset}>Recover your account</a></p>
    </section>
    <section className="commerce-panel">
      <h2>Country storefronts</h2>
      {first && <p>{saved ? "Preferred storefront" : "Suggested storefront"} <strong>{first.name}</strong></p>}
      <div className="customer-account__nav">{markets.map(entry =>
        <a key={entry.id} href={chooseStorefrontHref(entry.id)}>{entry.name}{entry.stagingOnly && " (staging fixture)"}</a>)}</div>
    </section>
  </div>;
}
