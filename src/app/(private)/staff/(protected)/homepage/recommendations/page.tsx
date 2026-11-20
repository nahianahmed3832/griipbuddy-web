import type { Metadata } from "next";
import Form from "next/form";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { isMarketId } from "@/config/markets";
import { previewMarketMatches } from "@/lib/catalog/homepage-content";
import { parseHomepageScope, scopeKey } from "@/lib/catalog/homepage-contract";
import { recommendationConfig } from "@/lib/catalog/recommendation-config";
import {
  recommendationPlacementLabels, recommendationPlacements, recommendationProductId, recommendationStrategyLabels,
} from "@/lib/catalog/recommendation-policy";
import { loadRecommendations, recommendationReasonLabels } from "@/lib/catalog/recommendations";
import { reportFailure } from "@/lib/db/observability";
import { marketConfiguration } from "@/lib/market-config";
import { requireStaff } from "@/lib/staff/access";
import { canEditHomepage } from "@/lib/staff/homepage";
import "../homepage-editor.css";

export const metadata: Metadata = { title: "Recommendation preview", robots: { index: false, follow: false } };

const scenarios = {
  anonymous: "New anonymous visitor",
  returning: "Returning visitor with consent",
  customer: "Customer with consent and purchase history",
  contextual: "Returning visitor with personalization disabled",
} as const;
const scenarioInput = z.enum(["anonymous", "returning", "customer", "contextual"]);
const placementInput = z.enum(recommendationPlacements);

export default async function RecommendationPreview({ searchParams }: { searchParams: Promise<{
  scope?: string; market?: string; locale?: string; scenario?: string; placement?: string; product?: string;
}> }) {
  const [staff, params] = await Promise.all([requireStaff(), searchParams]);
  const scope = parseHomepageScope(params.scope);
  if (!scope || !isMarketId(params.market) || !await canEditHomepage(staff.id, scope)) notFound();
  const market = marketConfiguration(params.market);
  const locale = params.locale ?? market.defaultLocale;
  if (!market.languages.includes(locale) || !previewMarketMatches(scope, market.id, locale)) notFound();
  const key = scopeKey(scope);
  const scenario = scenarioInput.safeParse(params.scenario).data ?? "anonymous";
  const placement = placementInput.safeParse(params.placement).data ?? "recommended";
  const product = recommendationProductId.safeParse(params.product).data;
  const allowBehavioral = scenario === "returning" || scenario === "customer";
  const syntheticIntent = product && allowBehavioral
    ? scenario === "customer" ? { purchased: [product], repurchaseDue: [product] } : { viewed: [product], carted: [product] }
    : {};
  const config = await recommendationConfig(market.id, locale, key);
  const policy = config.placements[placement];
  const result = await loadRecommendations({
    marketId: market.id, locale, placement, config, allowBehavioral, syntheticIntent,
    anchorProductId: placement === "similar" || placement === "complementary" ? product : undefined,
  }).catch(error => {
    reportFailure("staff.recommendation-preview", undefined, error);
    return null;
  });

  return <div className="homepage-office recommendation-preview">
    <h1 className="display-type">Recommendation preview</h1>
    <p>{market.name} · {locale} · {market.currency}</p>
    <p>Uses the saved draft for {key} and published settings from other applicable scopes. Shopper activity in this preview is simulated.</p>
    <Form action="/staff/homepage/recommendations" className="homepage-editor-actions">
      <input type="hidden" name="scope" value={key} />
      <input type="hidden" name="market" value={market.id} />
      <input type="hidden" name="locale" value={locale} />
      <label>Placement
        <select name="placement" defaultValue={placement}>{recommendationPlacements.map(value =>
          <option key={value} value={value}>{recommendationPlacementLabels[value]}</option>)}</select>
      </label>
      <label>Shopper scenario
        <select name="scenario" defaultValue={scenario}>{Object.entries(scenarios).map(([value, label]) =>
          <option key={value} value={value}>{label}</option>)}</select>
      </label>
      <label>Seed or anchor product ID<input name="product" maxLength={100} defaultValue={product ?? ""} /></label>
      <button type="submit" className="button button--outline">Run preview</button>
      <Link className="button button--outline" href={`/staff/homepage?scope=${encodeURIComponent(key)}#homepage-recommendations`}>Back to editor</Link>
    </Form>
    {params.product && !product && <p role="alert">Enter a valid catalog product ID.</p>}
    <p>The returning scenario views and carts the seed product. The customer scenario purchased the seed at least 14 days ago.</p>
    <section aria-labelledby="recommendation-preview-results">
      <h2 id="recommendation-preview-results">{recommendationPlacementLabels[placement]}</h2>
      <dl>
        <dt>Effective placement</dt><dd>{policy.enabled ? "Enabled" : "Disabled"}</dd>
        <dt>Effective behavioral setting</dt><dd>{config.behavioralEnabled ? "Enabled for shoppers with consent" : "Disabled"}</dd>
        <dt>Configured strategy</dt><dd>{recommendationStrategyLabels[policy.strategy]}</dd>
        {result && <>
          {result.strategy !== policy.strategy && <><dt>Strategy used</dt><dd>{recommendationStrategyLabels[result.strategy]}</dd></>}
          <dt>Recommendation version</dt><dd><code>{result.version}</code></dd>
        </>}
        <dt>Configuration version</dt><dd><code>{config.version}</code></dd>
      </dl>
      {result?.items.length ? <ol>{result.items.map(item => <li key={item.productId}>
        <strong>{item.product.name}</strong> · <code>{item.productId}</code> · {recommendationReasonLabels[item.reason]}
      </li>)}</ol> : result ? <p>There are no eligible products to show for this scenario.</p> : <p role="alert">The preview is unavailable. Try again.</p>}
    </section>
  </div>;
}
