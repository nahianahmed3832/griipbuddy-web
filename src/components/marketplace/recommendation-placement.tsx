"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { Market } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import type { ProductCardData } from "@/lib/catalog/listing";
import { useRecommendationStatus } from "@/lib/catalog/recommendation-preference-client";
import type { HomepageRecommendationRows, PrivateHomepagePlacement } from "@/lib/catalog/recommendation-presentation";
import { measurementCheckoutHeaders, useMeasurementChoice } from "@/lib/measurement/browser";
import { MeasuredHomepageSection, type Placement } from "../measurement-observers";
import { marketProductHref } from "../product-grid";
import { HomeBodyHeading, HomeProductRow } from "./home-body";
import styles from "./home.module.css";

const HomepageRows = createContext<HomepageRecommendationRows>({});

export function HomepageRecommendations({ market, placements, excludeProductIds, featuredProductIds, featuredProof, children }: {
  market: Market;
  placements: readonly PrivateHomepagePlacement[];
  excludeProductIds: readonly string[];
  featuredProductIds: readonly string[];
  featuredProof?: string;
  children: ReactNode;
}) {
  const preference = useRecommendationStatus(market.id);
  const measurement = useMeasurementChoice();
  const body = JSON.stringify({ marketId: market.id, locale: market.locale, placements, excludeProductIds, featuredProductIds, featuredProof });
  const key = JSON.stringify([body, preference.choice, preference.scope, measurement]);
  const [result, setResult] = useState<{ key: string; rows: HomepageRecommendationRows }>();

  useEffect(() => {
    if (!placements.length || measurement === "loading" || preference.choice === "loading") return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 5000);
    const session = preference.choice === "on" && measurement === "on" ? measurementCheckoutHeaders() : {};
    void fetch(storefrontPath("/api/recommendations"), {
      method: "POST", cache: "no-store", referrerPolicy: "no-referrer", signal: controller.signal,
      headers: { "content-type": "application/json", ...session }, body,
    }).then(async response => {
      if (!response.ok) return;
      const { rows } = await response.json() as { rows: HomepageRecommendationRows };
      if (!controller.signal.aborted) setResult({ key, rows });
    }).catch(() => { /* The already rendered editorial content stays available. */ })
      .finally(() => window.clearTimeout(timeout));
    return () => { controller.abort(); window.clearTimeout(timeout); };
  }, [body, key, measurement, placements.length, preference.choice]);

  return <HomepageRows.Provider value={result?.key === key ? result.rows : {}}>{children}</HomepageRows.Provider>;
}

export function HomepageRecommendationSlot({ id, placement, context, market, regional, title, fallbackCards = [], fallback, action, description }: {
  id: string;
  placement: PrivateHomepagePlacement;
  context: Placement;
  market: Market;
  regional: boolean;
  title: string;
  fallbackCards?: readonly ProductCardData[];
  fallback?: ReactNode;
  action?: { href: string; label: string };
  description?: string;
}) {
  const row = useContext(HomepageRows)[placement];
  if (!row || row.showFeatured && !row.assignment) return fallback;
  const cards = row.showFeatured ? fallbackCards : row.cards;
  if (!cards.length) return null;
  const header = row.showFeatured ? title : placement === "recommended"
    ? row.personalized ? "Recommended for you" : "Discover more"
    : title;
  const measurement = { ...context, placement, experimentAssignment: row.assignment?.id, recommendationVersion: row.version };
  return <MeasuredHomepageSection marketId={market.id} context={measurement} className={styles.editorialSection} aria-labelledby={id}
    data-recommendation-placement={placement} data-recommendation-variant={row.assignment?.variant}>
    <HomeBodyHeading id={id} title={header} action={row.showFeatured ? action : undefined} description={row.showFeatured ? description : undefined} />
    <HomeProductRow cards={cards} market={market} placement={measurement}
      linkForCard={card => marketProductHref(card.slug, market, regional, card.variantId)} />
  </MeasuredHomepageSection>;
}
