"use client";

import Link from "next/link";
import { useEffect, useEffectEvent, useRef, type ComponentProps, type ComponentPropsWithoutRef, type RefObject } from "react";
import type { Market, MarketId } from "@/config/markets";
import type { ProductCardData } from "@/lib/catalog/listing";
import { endMeasurementSession, trackMeasurement, useForegroundObservation, useMeasurementChoice } from "@/lib/measurement/browser";
import { safeSearchQuery } from "@/lib/measurement/search-privacy";
import type { CategoryFilterField, CategoryMeasurementSort, MeasurementFilters } from "@/lib/measurement/schema";

export type Placement = {
  placement: string;
  position?: number;
  categoryId?: string;
  homepageConfig?: string;
  sectionId?: string;
  experimentAssignment?: string;
  recommendationVersion?: string;
};

type Observation = { eligible: boolean; timer?: number; report: () => void };
const observed = new Map<Element, Observation>();
let observer: IntersectionObserver | undefined;

function updateVisibility(element: Element, observation: Observation) {
  window.clearTimeout(observation.timer);
  observation.timer = undefined;
  if (!observation.eligible || document.visibilityState !== "visible") return;
  const timer = window.setTimeout(() => {
    handleIntersections(observer?.takeRecords() ?? []);
    if (observation.timer !== timer || !observation.eligible || !element.isConnected || document.visibilityState !== "visible" ||
      element.checkVisibility?.({ opacityProperty: true, visibilityProperty: true }) === false) return;
    stopObserving(element);
    observation.report();
  }, 750);
  observation.timer = timer;
}

function onDocumentVisibility() {
  for (const [element, observation] of observed) updateVisibility(element, observation);
}

function stopObserving(element: Element) {
  window.clearTimeout(observed.get(element)?.timer);
  observed.delete(element);
  observer?.unobserve(element);
  if (observed.size) return;
  observer?.disconnect();
  observer = undefined;
  document.removeEventListener("visibilitychange", onDocumentVisibility);
}

function handleIntersections(entries: IntersectionObserverEntry[]) {
  for (const entry of entries) {
    const observation = observed.get(entry.target);
    if (!observation) continue;
    const eligible = entry.isIntersecting && entry.intersectionRatio >= 0.5 &&
      entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0;
    if (eligible === observation.eligible) continue;
    observation.eligible = eligible;
    updateVisibility(entry.target, observation);
  }
}

function observeImpression(element: Element, report: () => void) {
  if (typeof IntersectionObserver !== "function") return;
  if (!observer) {
    observer = new IntersectionObserver(handleIntersections, { threshold: 0.5 });
    document.addEventListener("visibilitychange", onDocumentVisibility);
  }
  observed.set(element, { eligible: false, report });
  observer.observe(element);
  return () => stopObserving(element);
}

function useImpression(ref: RefObject<HTMLElement | null>, key: string, enabled: boolean, report: () => void, target?: string) {
  const choice = useMeasurementChoice();
  const reported = useRef("");
  const emit = useEffectEvent(report);
  useEffect(() => {
    if (choice !== "on" || !enabled || reported.current === key || !ref.current) return;
    const element = target ? ref.current.querySelector(target) : ref.current;
    if (!element) return;
    return observeImpression(element, () => {
      reported.current = key;
      emit();
    });
  }, [choice, enabled, key, ref, target]);
}

export function MeasuredProductLink({ card, market, context, preview = false, ...props }:
  Omit<ComponentProps<typeof Link>, "ref"> & {
    card: Pick<ProductCardData, "id"> & Partial<Pick<ProductCardData, "variantId" | "priceMinor">> & { offerId?: string };
    market: Market;
    context: Placement;
    preview?: boolean;
  }) {
  const ref = useRef<HTMLAnchorElement>(null);
  const payload = { ...context, marketId: market.id, productId: card.id, variantId: card.variantId, offerId: card.offerId,
    displayedPriceMinor: card.priceMinor, currency: card.priceMinor === undefined ? undefined : market.currency };
  useImpression(ref, JSON.stringify(payload), !preview, () => trackMeasurement({ action: "PRODUCT_IMPRESSION", ...payload }));
  return <Link {...props} ref={ref} onClick={event => {
    props.onClick?.(event);
    if (!preview && !event.defaultPrevented) trackMeasurement({ action: "PRODUCT_CLICK", ...payload });
  }} onAuxClick={event => {
    props.onAuxClick?.(event);
    if (!preview && event.button === 1 && !event.defaultPrevented) trackMeasurement({ action: "PRODUCT_CLICK", ...payload });
  }}/>;
}

export function MeasuredCategoryLink({ categoryId, marketId, context, ...props }:
  Omit<ComponentProps<typeof Link>, "ref"> & {
    categoryId: string;
    marketId: MarketId;
    context: { placement: "category-children" | "category-navigation" | "search-category-suggestion"; position?: number };
  }) {
  const report = () => trackMeasurement({ action: "CATEGORY_CLICK", categoryId, marketId, ...context });
  return <Link {...props} onClick={event => {
    props.onClick?.(event);
    if (!event.defaultPrevented) report();
  }} onAuxClick={event => {
    props.onAuxClick?.(event);
    if (event.button === 1 && !event.defaultPrevented) report();
  }}/>;
}

export function CategoryListingMeasurement({ categoryId, marketId, resultCount, filterKey, filterFields, sort }: {
  categoryId: string;
  marketId: MarketId;
  resultCount: number;
  filterKey: string;
  filterFields: readonly CategoryFilterField[];
  sort?: CategoryMeasurementSort;
}) {
  const scope = JSON.stringify([marketId, categoryId]);
  const context = { categoryId, marketId, resultCount, placement: "category-listing" };
  const previous = useRef<{ scope: string; filtered: boolean; sort?: CategoryMeasurementSort }>(null);
  useForegroundObservation(scope, true, () => trackMeasurement({ action: "CATEGORY_IMPRESSION", ...context }));
  useForegroundObservation(JSON.stringify([scope, filterKey, sort]), true, () => {
    const last = previous.current;
    const filtered = filterFields.length > 0;
    previous.current = { scope, filtered, sort };
    if (filtered || (sort && sort !== "recommended") || (last?.scope === scope && (last.filtered || last.sort !== sort))) {
      trackMeasurement({ action: "CATEGORY_FILTER", ...context, categoryFilters: { fields: [...filterFields], sort } });
    }
  });
  return null;
}

export function MeasuredHomepageSection({ marketId, context, ...props }:
  ComponentPropsWithoutRef<"section"> & { marketId: MarketId; context: Placement }) {
  const ref = useRef<HTMLElement>(null);
  useImpression(ref, JSON.stringify([marketId, context]), true, () => {
    trackMeasurement({ action: "HOMEPAGE_SECTION_IMPRESSION", marketId, ...context });
  }, "h1, h2");
  useImpression(ref, JSON.stringify([marketId, context]), Boolean(context.experimentAssignment), () => {
    trackMeasurement({ action: "EXPERIMENT_EXPOSURE", marketId, ...context });
  }, ".product-card__image");
  return <section {...props} ref={ref}/>;
}

export function ListingMeasurement({ marketId, placement, query, resultCount, filters, active }: {
  marketId: MarketId; placement: string; query?: string; resultCount: number; filters: MeasurementFilters; active: boolean;
}) {
  const previous = useRef<{ marketId: MarketId; placement: string; query?: string; active: boolean }>(null);
  useForegroundObservation(JSON.stringify([marketId, placement, query, filters]), true, () => {
    const last = previous.current;
    previous.current = { marketId, placement, query, active };
    const sameSearch = last?.marketId === marketId && last.placement === placement && last.query === query;
    const safeQuery = safeSearchQuery(query);
    if (query && !sameSearch) trackMeasurement({ action: "SEARCH", marketId, query: safeQuery, resultCount, filters, placement });
    else if (active || (sameSearch && last.active)) {
      trackMeasurement({ action: "SEARCH_FILTER", marketId, query: safeQuery, resultCount, filters, placement });
    }
  });
  return null;
}

export function SearchResultsMeasurement({ marketId, query, resultCount, filterKey, filterFields, sort, filters }: {
  marketId: MarketId; query: string; resultCount: number; filterKey: string;
  filterFields: readonly CategoryFilterField[]; sort?: CategoryMeasurementSort; filters: MeasurementFilters;
}) {
  const scope = JSON.stringify([marketId, query]);
  const previous = useRef<{ scope: string; active: boolean }>(null);
  useForegroundObservation(JSON.stringify([scope, filterKey, sort]), true, () => {
    const seen = previous.current;
    const active = Boolean(filterFields.length || sort && sort !== "recommended");
    previous.current = { scope, active };
    const context = { marketId, placement: "search-results", query: safeSearchQuery(query), resultCount, filters };
    if (seen?.scope !== scope) trackMeasurement({ action: "SEARCH", ...context });
    if (active || (seen?.scope === scope && seen.active)) {
      trackMeasurement({ action: "SEARCH_FILTER", ...context, categoryFilters: { fields: [...filterFields], sort } });
    }
  });
  return null;
}

export function MeasurementAccountAssociation({ marketId, signedIn }: { marketId: MarketId; signedIn: boolean }) {
  const state = useMeasurementChoice();
  const association = useRef<{ marketId: MarketId; wasSignedIn: boolean; reported: boolean }>({
    marketId, wasSignedIn: signedIn, reported: false,
  });
  useEffect(() => {
    const previous = association.current;
    if (!signedIn) {
      if (previous.wasSignedIn) endMeasurementSession();
      association.current = { marketId, wasSignedIn: false, reported: false };
      return;
    }
    if (state !== "on") {
      association.current = { marketId, wasSignedIn: true, reported: false };
      return;
    }
    const observe = () => {
      const current = association.current;
      if (document.visibilityState !== "visible" || current.marketId === marketId && current.reported) return;
      trackMeasurement({ action: "ACCOUNT_ASSOCIATED", marketId });
      association.current = { marketId, wasSignedIn: true, reported: true };
    };
    observe();
    document.addEventListener("visibilitychange", observe);
    return () => document.removeEventListener("visibilitychange", observe);
  }, [marketId, signedIn, state]);
  return null;
}
