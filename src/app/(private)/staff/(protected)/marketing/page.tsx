import Link from "next/link";
import { notFound } from "next/navigation";
import { isMarketId } from "@/config/markets";
import { fixtureFeedExportEnabled } from "@/lib/catalog/merchant-feed-export";
import { marketConfiguration } from "@/lib/market-config";
import { clarityProject } from "@/lib/measurement/clarity-config";
import { measurementEnabled } from "@/lib/measurement/server";
import { marketplaceMode, storefrontIndexingEnabled } from "@/lib/release-config";
import { requireStaff } from "@/lib/staff/access";
import { staffMarketIds } from "@/lib/staff/market-access";

export const metadata = { title: "Marketing", robots: { index: false, follow: false } };

export default async function MarketingPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [staff, params] = await Promise.all([requireStaff(), searchParams]);
  const [reporting, commercial] = await Promise.all([
    staffMarketIds(staff.id, "reporting"), staffMarketIds(staff.id, "commercial"),
  ]);
  const markets = staff.role === "OWNER" ? [...new Set([...reporting, ...commercial])] : reporting;
  const requested = params.market;
  if (!markets.length || (requested !== undefined && (!isMarketId(requested) || !markets.includes(requested)))) notFound();

  const market = marketConfiguration(requested ?? markets[0]);
  const reportAccess = reporting.includes(market.id);
  const catalogAccess = staff.role === "OWNER" && commercial.includes(market.id);
  const firstParty = measurementEnabled() && market.analytics.structured === "first-party";
  const testReport = fixtureFeedExportEnabled(market.id);
  return <>
    <header className="commerce-intro">
      <h1 className="display-type">Marketing</h1>
      <p>{market.name} · {market.currency} · {market.timeZone}</p>
    </header>
    <nav className="staff-filters" aria-label="Marketing markets">
      {markets.map(id => <Link key={id} href={`/staff/marketing?market=${id}`}
        aria-current={id === market.id ? "page" : undefined}>{marketConfiguration(id).name}</Link>)}
    </nav>
    <div className="commerce-stack">
      {reportAccess && <section className="commerce-panel commerce-stack" aria-labelledby="marketing-measurement">
        <h2 id="marketing-measurement">Acquisition and attribution</h2>
        <nav className="commerce-fields" aria-label="Measurement reports">
          <Link className="button button--outline" href={`/staff/acquisition?market=${market.id}`}>Market report</Link>
          <Link className="button button--outline" href={`/staff/acquisition?market=${market.id}&view=events`}>Event diagnostics</Link>
          {testReport && <Link className="button button--outline" href={`/staff/acquisition?market=${market.id}&scope=test&view=events`}>Test events</Link>}
        </nav>
        <dl>
          <div><dt>First-party measurement</dt><dd>{firstParty ? "Available after opt-in" : "Disabled"}</dd></div>
          <div><dt>Session replay</dt><dd>{firstParty && clarityProject(market) ? "Configured. Separate opt-in required." : "Disabled"}</dd></div>
          <div><dt>GA4 and Meta conversion delivery</dt><dd>Disabled</dd></div>
        </dl>
        <p>Acquisition uses consented observations and saved commerce outcomes. Staff browsers and Global Privacy Control suppress optional measurement.</p>
      </section>}
      {catalogAccess && <section className="commerce-panel commerce-stack" aria-labelledby="marketing-promotions">
        <h2 id="marketing-promotions">Offers and participation</h2>
        <nav className="commerce-fields" aria-label="Offer operations">
          <Link className="button button--outline" href={`/staff/catalog/feeds?market=${market.id}`}>Catalog feeds</Link>
          {marketplaceMode() && <>
            <Link className="button button--outline" href={`/staff/coupons?market=${market.id}`}>Coupons</Link>
            <Link className="button button--outline" href={`/staff/seller-hub?market=${market.id}&tab=campaigns`}>Seller invitations</Link>
            <Link className="button button--outline" href={`/staff/homepage?market=${market.id}`}>Homepage placements</Link>
          </>}
        </nav>
        <p>Invitations record seller participation. Coupon, offer and publishing permissions still apply in their own workspaces.</p>
      </section>}
      {catalogAccess && <section className="commerce-panel commerce-stack" aria-labelledby="marketing-provider">
        <h2 id="marketing-provider">Provider status</h2>
        <dl>
          <div><dt>Catalog downloads</dt><dd>{testReport ? "Native development market available" : "Development export unavailable"}</dd></div>
          <div><dt>Google and Meta submission</dt><dd>Disabled</dd></div>
          <div><dt>Facebook comments and custom scripts</dt><dd>Disabled</dd></div>
          <div><dt>Search indexing</dt><dd>{storefrontIndexingEnabled() ? "Release policy enabled" : "Disabled for this environment"}</dd></div>
        </dl>
        <p>Provider activation and publishing require separate account verification and approved scope.</p>
      </section>}
    </div>
  </>;
}
