import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { HomeMerchandising } from "@/components/marketplace/home";
import { isMarketId } from "@/config/markets";
import { previewMarketMatches } from "@/lib/catalog/homepage-content";
import { parseHomepageScope, scopeKey } from "@/lib/catalog/homepage-contract";
import { mainAdminCatalogConfig, mainAdminHomepageRequested } from "@/lib/catalog/main-admin-config";
import { localMarketTime } from "@/lib/market-calendar";
import { marketConfiguration } from "@/lib/market-config";
import { requireStaff } from "@/lib/staff/access";
import { canEditHomepage } from "@/lib/staff/homepage";

export const metadata: Metadata = { title: "Homepage draft preview", robots: { index: false, follow: false } };

export default async function HomepagePreview({ searchParams }: { searchParams: Promise<{
  scope?: string; market?: string; locale?: string; at?: string;
}> }) {
  const [staff, params] = await Promise.all([requireStaff(), searchParams]);
  const scope = parseHomepageScope(params.scope);
  if (!scope || !isMarketId(params.market) || !await canEditHomepage(staff.id, scope)) notFound();
  const market = marketConfiguration(params.market);
  const locale = params.locale ?? market.defaultLocale;
  if (!market.languages.includes(locale) || !previewMarketMatches(scope, market.id, locale)) notFound();
  if (mainAdminHomepageRequested()) {
    const connected = mainAdminCatalogConfig(true);
    if (!connected || ![...connected.actors.values()].includes(staff.id)) notFound();
    const target = new URL("/admin/dashboard/homepage", connected.origin);
    target.searchParams.set("region", market.id === "us" ? "INTERNATIONAL" : "BD");
    redirect(target.href);
  }
  const at = params.at ? localMarketTime(params.at, market.timeZone) : undefined;
  return <>
    <div className="homepage-office">
      <h1 className="display-type">Homepage draft preview</h1>
      <p>{market.name} · {locale} · {market.timeZone}</p>
      <Form action="/staff/homepage/preview" className="homepage-editor-actions">
        <input type="hidden" name="scope" value={scopeKey(scope)} />
        <input type="hidden" name="market" value={market.id} />
        <input type="hidden" name="locale" value={locale} />
        <label>Preview at market local time<input type="datetime-local" name="at" defaultValue={params.at ?? ""} /></label>
        <button type="submit" className="button button--outline">Update preview</button>
        <Link className="button button--outline" href={`/staff/homepage?scope=${encodeURIComponent(scopeKey(scope))}`}>Back to editor</Link>
      </Form>
      {params.at && !at && <p role="alert">Choose an unambiguous local date and time.</p>}
    </div>
    <HomeMerchandising market={{ ...market, locale }} previewScopeKey={scopeKey(scope)} at={at ?? undefined} />
  </>;
}
