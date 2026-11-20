import Image from "next/image";
import Link from "next/link";
import { cookies, headers } from "next/headers";
import type { ReactNode } from "react";
import { storefrontPath } from "@/config/storefront-path";
import { formatMoney } from "@/config/markets";
import { heroPhoto } from "@/lib/catalog/imagery";
import { catalogBrowseHref, catalogProductHref } from "@/lib/catalog/category-browse-links";
import { homepageLayout } from "@/lib/catalog/homepage-layout";
import { homepageSectionPlacements } from "@/lib/catalog/homepage-contract";
import type { ProductCardData } from "@/lib/catalog/listing";
import type { MarketConfiguration } from "@/lib/market-config";
import { hybridDemoMode } from "@/lib/release-config";
import { getDb } from "@/lib/db/client";
import { reportFailure } from "@/lib/db/observability";
import { cookieId, hasStaffMeasurementSession, measurementCookie, measurementEnabled } from "@/lib/measurement/server";
import { productHref } from "../product-grid";
import { MeasuredHomepageSection, MeasuredProductLink, type Placement } from "../measurement-observers";
import { RecentlyViewed } from "./recent";
import { HomeBodySection } from "./home-body";
import { HomepageRecommendations, HomepageRecommendationSlot } from "./recommendation-placement";
import type { PrivateHomepagePlacement } from "@/lib/catalog/recommendation-presentation";
import { featuredPlacementProof } from "@/lib/catalog/recommendation-experiment";
import styles from "./home.module.css";

export function HomeLoading() {
  return <div className={`shell home ${styles.bodyState}`} role="status">Loading shopping sections…</div>;
}

function HomeSection({ marketId, context, preview, label, className, children }: {
  marketId: MarketConfiguration["id"]; context: Placement; preview: boolean; label: string; className?: string; children: ReactNode;
}) {
  return preview
    ? <section aria-labelledby={label} className={className}>{children}</section>
    : <MeasuredHomepageSection marketId={marketId} context={context} aria-labelledby={label} className={className}>{children}</MeasuredHomepageSection>;
}

export async function HomeMerchandising({ market, previewScopeKey, at }: {
  market: MarketConfiguration; previewScopeKey?: string; at?: Date;
}) {
  const preview = Boolean(previewScopeKey);
  let personalized = false;
  if (!preview && market.analytics.structured === "first-party" && measurementEnabled()) {
    try {
      const [storage, request] = await Promise.all([cookies(), headers()]);
      const id = cookieId(storage.get(measurementCookie)?.value);
      if (id && request.get("sec-gpc") !== "1" && !hasStaffMeasurementSession(request)) {
        personalized = Boolean(await getDb().measurementJourney.count({ where: { id, expiresAt: { gt: new Date() } } }));
      }
    } catch { /* The public homepage remains available when consent lookup fails. */ }
  }
  const route = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  const layout = await homepageLayout(market, { previewScopeKey, at, personalized }).catch(error => {
    if (preview) throw error;
    reportFailure("catalog.homepage", undefined, error);
    return null;
  });
  if (!layout) return <div className={`shell home ${styles.bodyState}`} lang={market.locale}>
    <h1 className="display-type">Shop {market.name}</h1><p>Shopping sections are temporarily unavailable.</p>
    <form method="get">
      <input type="hidden" name="market" value={market.id} /><input type="hidden" name="lang" value={market.locale} />
      <button className="button button--outline" type="submit">Try again</button>
      <Link className="button button--primary" href={catalogBrowseHref("/shop", route)}>Shop all</Link>
    </form>
  </div>;
  const { panels, measurement, carry, ranking, marketCoverage } = layout;
  const cardHref = (card: ProductCardData) => catalogProductHref({
    slug: card.slug, matchedVariantId: card.variantId, knownOptions: [],
  }, route);
  const topBanner = panels[0]?.section.type === "BANNER";
  // Explicitly authored selections keep their catalogue placement when recommendation ranking is enabled.
  const feature = panels.findIndex(({ section }) => section.type === "FEATURED" && !section.productIds?.length);
  const continueIndex = panels.findIndex(({ section }) => section.type === "RECENTLY_VIEWED");
  const enabled: PrivateHomepagePlacement[] = [];
  if (!preview && marketCoverage) {
    if (ranking.placements.recommended.enabled && (feature < 0 || ranking.behavioralEnabled || ranking.placements.recommended.configured)) enabled.push("recommended");
    if (continueIndex >= 0) enabled.push("continue");
    if (ranking.behavioralEnabled && ranking.placements["buy-again"].enabled) enabled.push("buy-again");
  }
  const featureCards = feature < 0 ? [] : panels[feature].cards ?? [];
  const featureIds = featureCards.map(card => card.id);
  const featuredProof = !preview && enabled.includes("recommended") ? featuredPlacementProof({
    marketId: market.id, locale: market.locale, version: ranking.version, productIds: featureIds,
  }) : undefined;
  const excludeProductIds = panels.flatMap(({ cards }, index) => index !== feature ? (cards ?? []).map(card => card.id) : []).slice(0, 256);
  return <div id={preview ? "product-preview" : undefined} className={`shell home ${styles.home}`} lang={market.locale}>
    <HomepageRecommendations market={market} placements={enabled} featuredProductIds={featureIds} featuredProof={featuredProof} excludeProductIds={excludeProductIds}>
    {!topBanner && !preview && <h1 className="display-type">Shop {market.name}</h1>}
    {panels.map(({ section, cards = [], departments, collections, recommendations, evidenceFallback, recommendationVersion }, index) => {
      const heading = `home-section-${section.key}`;
      const context = { placement: homepageSectionPlacements[section.type], position: index + 1, homepageConfig: measurement, recommendationVersion,
        ...(section.type !== "BANNER" && { sectionId: section.key }) };
      if (section.type === "BANNER") {
        const hero = section.bannerImage ?? (section.key === "hero" ? heroPhoto : cards[0]?.image ?? heroPhoto);
        const title = index === 0 && !preview ? "h1" : "h2";
        const Title = title;
        const link = section.link ?? (carry && section.key === "hero"
          ? { label: "Shop Everyday Carry", href: "/collections/everyday-carry" } : { label: "Shop all", href: "/shop" });
        return <HomeSection key={section.key} marketId={market.id} context={context} preview={preview} label={heading}
          className={`hero ${styles.banner}`}>
          <div className="hero__visual">
            <Image src={storefrontPath(hero.src)} alt={hero.alt} fill preload={index === 0} sizes="(max-width: 700px) 100vw, 65vw" />
          </div>
          <div className="hero__aside">
            {cards.length > 0 && <ul className="hero__products" aria-label="Featured products">
              {cards.map((card, offset) => <li key={card.id}>
                <MeasuredProductLink card={card} market={market} context={{ ...context, position: offset + 1 }}
                  href={preview ? "#product-preview" : productHref(card)} preview={preview}
                  aria-label={`${card.name}, ${formatMoney(card.priceMinor, market)}`}>
                  <Image src={storefrontPath(card.image.src)} alt={card.image.alt} fill sizes="(max-width: 700px) 25vw, 210px" />
                  <span>{card.multiplePrices && "From "}{formatMoney(card.priceMinor, market)}</span>
                </MeasuredProductLink>
              </li>)}
            </ul>}
            <div className="hero__copy">
              <Title id={heading} className="display-type">{section.title}</Title>
              {section.description && <p>{section.description}</p>}
              <Link className="button button--primary hero__cta" href={preview ? "#product-preview" : link.href}>{link.label}</Link>
            </div>
          </div>
        </HomeSection>;
      }
      if (recommendations) {
        return preview ? null : <RecentlyViewed key={section.key} items={recommendations} market={market} placement={context}
          similar={section.type === "RELATED"} title={section.title} heading={heading} limit={section.limit ?? 6} />;
      }
      if (section.type === "RECENTLY_VIEWED") return index !== continueIndex || preview ? null
        : <HomepageRecommendationSlot key={section.key} id={heading} market={market} context={context} placement="continue" regional={route.regional}
          title={section.key === "recent" && section.title === "Recently viewed" ? "Continue browsing" : section.title} />;
      const title = evidenceFallback ? "Curated picks" : section.title;
      const editorial = <HomeSection key={section.key} marketId={market.id} context={context} preview={preview} label={heading} className={styles.editorialSection}>
        <HomeBodySection section={section} title={title} heading={heading} description={evidenceFallback ? undefined : section.description}
          departments={departments} collections={collections} cards={cards} market={market} placement={context}
          preview={preview} browseHref={path => catalogBrowseHref(path, route)} linkForCard={cardHref} />
      </HomeSection>;
      return index === feature && enabled.includes("recommended")
        ? <HomepageRecommendationSlot key={section.key} id={heading} market={market} placement="recommended" regional={route.regional}
          context={context} title={title} fallbackCards={cards} fallback={editorial} action={section.link} description={section.description} />
        : editorial;
    })}
    {feature < 0 && enabled.includes("recommended") && <HomepageRecommendationSlot id="home-recommendations" market={market} regional={route.regional}
      context={{ placement: "recommended", homepageConfig: measurement, position: panels.length + 1 }} placement="recommended" title="Recommended for you" />}
    {enabled.includes("buy-again") && <HomepageRecommendationSlot id="home-buy-again" market={market} regional={route.regional}
      context={{ placement: "buy-again", homepageConfig: measurement, position: panels.length + (feature < 0 ? 2 : 1) }} placement="buy-again" title="Buy again" />}
    </HomepageRecommendations>
  </div>;
}
