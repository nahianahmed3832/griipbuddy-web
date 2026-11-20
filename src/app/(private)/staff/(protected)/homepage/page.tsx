import { isDeepStrictEqual } from "node:util";
import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { notFound } from "next/navigation";
import { HomepageEditor, MarketGrantForm, PublishHomepage } from "@/components/homepage-editor";
import { RecommendationPolicyEditor } from "@/components/recommendation-policy-editor";
import { marketList } from "@/config/markets";
import { publishedHomepage } from "@/lib/catalog/homepage-content";
import { mainAdminCatalogConfig, mainAdminHomepageRequested } from "@/lib/catalog/main-admin-config";
import { defaultHomepage, homepageInput, mergeHomepage, parseHomepageScope, scopeKey, type HomepageScope } from "@/lib/catalog/homepage-contract";
import { getDb } from "@/lib/db/client";
import { marketConfiguration } from "@/lib/market-config";
import { requireStaff } from "@/lib/staff/access";
import { homepageEditorData } from "@/lib/staff/homepage";
import { staffMarketIds } from "@/lib/staff/market-access";
import "./homepage-editor.css";

export const metadata: Metadata = { title: "Homepage merchandising" };

export default async function HomepageOffice({ searchParams }: { searchParams: Promise<{ scope?: string }> }) {
  const [staff, params] = await Promise.all([requireStaff(), searchParams]);
  const connected = mainAdminHomepageRequested();
  const bridge = connected ? mainAdminCatalogConfig(true) : null;
  const connectedUrl = bridge && [...bridge.actors.values()].includes(staff.id) ?
    new URL("/admin/dashboard/homepage", bridge.origin).href : null;
  const permitted = await staffMarketIds(staff.id, "merchandising");
  const available = marketList.filter(market => permitted.includes(market.id)).map(market => marketConfiguration(market.id));
  if (!available.length) notFound();
  const owner = staff.role === "OWNER";
  const locales = [...new Set(available.flatMap(market => market.languages))];
  const globalScopes = owner
    ? [{ label: "Global template", scope: {} }, ...locales.map(locale => ({ label: `Global template · ${locale}`, scope: { locale } }))]
    : [];
  const scopes: { label: string; scope: HomepageScope }[] = [...globalScopes, ...available.flatMap(market => [
    { label: market.name, scope: { marketId: market.id } },
    ...market.languages.map(locale => ({ label: `${market.name} · ${locale}`, scope: { marketId: market.id, locale } })),
  ])];
  const selected = params.scope ? parseHomepageScope(params.scope) : scopes[0].scope;
  const picked = selected && scopes.find(entry => scopeKey(entry.scope) === scopeKey(selected));
  if (!picked) notFound();
  const keys = scopeKey(picked.scope);
  const [row, users, grants] = await Promise.all([
    homepageEditorData(staff.id, picked.scope),
    owner ? getDb().staffAccess.findMany({ where: { active: true, role: { not: "OWNER" } }, select: { userId: true, user: { select: { name: true } } } }) : [],
    owner ? getDb().staffMarketAccess.findMany({ where: { staff: { active: true }, OR: [{ merchandising: true }, { reporting: true }] },
      include: { staff: { include: { user: { select: { name: true } } } } },
      orderBy: [{ marketId: "asc" }, { userId: "asc" }] }) : [],
  ]);
  const draft = homepageInput.safeParse(row?.draft);
  const content = draft.success ? draft.data : keys === "global:default" ? defaultHomepage : { sections: [], hiddenSections: [] };
  const live = homepageInput.safeParse(row?.history.find(release => release.id === row.publishedId)?.content).data;
  const publishedPolicy = live?.recommendations;
  const managedLayout = connected || [content, live].some(version => version?.sections.some(section => section.type === "TILES"));
  const previewMarkets = available.filter(market => (!picked.scope.marketId || picked.scope.marketId === market.id) &&
    (!picked.scope.locale || market.languages.includes(picked.scope.locale)));
  const keyReference = previewMarkets[0] && await publishedHomepage(previewMarkets[0].id, picked.scope.locale ?? previewMarkets[0].locale);
  return <div className="homepage-office">
    <h1 className="display-type">Homepage merchandising</h1>
    <Form action="/staff/homepage" className="homepage-editor-actions">
      <label>Template scope<select name="scope" defaultValue={keys}>{scopes.map(entry =>
        <option key={scopeKey(entry.scope)} value={scopeKey(entry.scope)}>{entry.label}</option>)}</select></label>
      <button type="submit" className="button button--outline">Open editor</button>
    </Form>

    {managedLayout ? <p>{connectedUrl ? <a href={connectedUrl}>Manage homepage sections in the main admin</a> :
      "Homepage sections are managed in the main admin by enrolled staff."}</p> : <section aria-labelledby="homepage-draft"><h2 id="homepage-draft">Draft</h2>
      <p>Use an inherited section key to override it. Market and language overrides take precedence over the global template.</p>
      {keyReference && <details><summary>Published section keys</summary><ul>{mergeHomepage(keyReference.layers).map(section =>
        <li key={section.key}><code>{section.key}</code> · {section.title}</li>)}</ul></details>}
      <HomepageEditor key={`${keys}:${row?.revision ?? 0}`} scope={keys} revision={row?.revision ?? 0} initial={content} />
    </section>}

    <section aria-labelledby="homepage-recommendations">
      <h2 id="homepage-recommendations">Recommendations</h2>
      <p>Editing {picked.label}. Settings apply in this order, with the last value taking precedence.</p>
      <p>Global template → global language → market → market language. Use an empty product override to clear an inherited list.</p>
      <p>{connected ? "Publish the saved recommendation policy. Section layout is published from the main admin." :
        managedLayout ? "Section layout is published from the main admin." :
        "Publish the saved homepage draft to apply layout and recommendation changes. Use publishing history to restore both."}</p>
      {!isDeepStrictEqual(content.recommendations, publishedPolicy) && <p role="status">Saved recommendation changes are pending publication.</p>}
      <RecommendationPolicyEditor key={`policy:${keys}:${row?.revision ?? 0}`} scope={keys} revision={row?.revision ?? 0} draft={content.recommendations} />
      <div className="homepage-editor-actions">{previewMarkets.map(market => <Link className="button button--outline" key={market.id}
        href={`/staff/homepage/recommendations?${new URLSearchParams({ scope: keys, market: market.id, locale: picked.scope.locale ?? market.locale })}`}>
        Preview recommendations · {market.name}</Link>)}</div>
    </section>

    {row && (!managedLayout || connected) && <section aria-labelledby="homepage-publish"><h2 id="homepage-publish">{connected ? "Publish recommendation policy" : "Preview and publish"}</h2>
      <div className="homepage-editor-actions">{!connected && previewMarkets.map(market => <Link className="button button--outline" key={market.id}
        href={`/staff/homepage/preview?${new URLSearchParams({ scope: keys, market: market.id, locale: picked.scope.locale ?? market.locale })}`}>
        Preview {market.name} · {picked.scope.locale ?? market.locale}</Link>)}
        <PublishHomepage key={row.revision} scope={keys} revision={row.revision} />
      </div>
    </section>}
    {row && row.history.length > 0 && <section aria-labelledby="homepage-history"><h2 id="homepage-history">Publishing history</h2>
      <ul className="homepage-history">{row.history.map(release => {
        const version = homepageInput.safeParse(release.content).data;
        const canRestore = !managedLayout && release.id !== row.publishedId && !version?.sections.some(section => section.type === "TILES");
        return <li key={release.id}>
          <div><time dateTime={release.publishedAt.toISOString()}>{release.publishedAt.toLocaleString(picked.scope.locale || "en", {
            timeZone: picked.scope.marketId ? marketConfiguration(picked.scope.marketId).timeZone : "UTC",
            dateStyle: "medium", timeStyle: "short",
          })}</time> {release.id === row.publishedId ? " · Live" : release.restoredFrom && " · Restored"}
          {version?.recommendations && " · Recommendation policy"}</div>
          {canRestore && <PublishHomepage key={`${release.id}:${row.revision}`} scope={keys} revision={row.revision} restore={release.id} />}
        </li>;
      })}</ul>
    </section>}

    {owner && <section aria-labelledby="homepage-access"><h2 id="homepage-access">Market staff access</h2>
      {grants.length > 0 && <ul>{grants.map(grant => <li key={`${grant.userId}:${grant.marketId}`}>
        {grant.staff.user.name} · {marketConfiguration(grant.marketId).name}
        {grant.merchandising && " · Homepage"}{grant.reporting && " · Reporting"}
      </li>)}</ul>}
      <MarketGrantForm users={users.map(row => ({ id: row.userId, name: row.user.name }))} markets={marketList.map(({ id, name }) => ({ id, name }))} />
    </section>}
  </div>;
}
