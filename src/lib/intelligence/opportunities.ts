import { getMarket, type MarketId } from "../../config/markets.ts";
import { marketDayStart, shiftCalendarDay } from "../market-calendar.ts";
import { stableMeasurementId } from "../measurement/domain.ts";
import { wilsonInterval } from "../measurement/intervals.ts";
import { safeSearchQuery } from "../measurement/search-privacy.ts";
import { intelligenceUrl } from "./navigation.ts";
import type { IntelligenceWindow, ProductIntelligenceReport, ProductIntelligenceRow } from "./types.ts";

export type OpportunityKind = "growing-demand" | "demonstrated-demand" | "unmet-search" | "variant-gap" |
  "conversion" | "availability" | "contribution" | "test-candidate";

export type OpportunityAssessment = {
  id: string;
  kind: OpportunityKind;
  signal: "interest" | "demonstrated-demand" | "profitable-demand" | "operational";
  title: string;
  marketId: MarketId;
  productId?: string;
  variantId?: string | null;
  term?: string;
  facts: string[];
  hypothesis: string;
  limitations: string[];
  sample: number;
  confidence: "limited" | "directional" | "strong";
  action: "investigate" | "test" | "hold" | "reduce-exposure";
  href: string;
};

const dayMs = 86_400_000;
const number = (value: number) => value.toLocaleString("en-US");
const percent = (value: number) => `${Math.round(value * 100)}%`;
const studied = (value: number, label: string) => `${number(value)} ${label}`;
const searchLimit = "Searches show interest. Validate buying intent through a market test with verified purchases.";
const checkoutLimit = "Linked completion covers consented journeys with verified payment or COD collection and can trail a recent view.";
const missingCausality = "Placement, price, campaigns and buyer intent can affect the observed rate. Test potential causes separately.";
const availabilityLimit = "Inventory observations are scheduled snapshots. Gaps leave availability unknown.";

export function intelligenceEvidenceHref(report: Pick<ProductIntelligenceReport, "marketId" | "test" | "window">,
  view: "overview" | "forecast", productId?: string, variantId?: string | null) {
  return intelligenceUrl({ market: report.marketId, scope: report.test ? "test" : "live", view,
    from: report.window.from, to: report.window.to, product: productId, variant: variantId ?? undefined });
}

function exactDays(window: IntelligenceWindow) {
  const midnight = (day: string) => Date.parse(`${day}T00:00:00.000Z`);
  return Math.round((midnight(window.to) - midnight(window.from)) / dayMs) + 1;
}

export function previousOpportunityWindow(window: IntelligenceWindow) {
  const length = exactDays(window);
  if (!Number.isSafeInteger(length) || length < 1 || length > 90) return null;
  const from = shiftCalendarDay(window.from, -length), to = shiftCalendarDay(window.from, -1);
  return from && to ? { from, to } : null;
}

function completeWindow(window: IntelligenceWindow) {
  const next = shiftCalendarDay(window.to, 1);
  return next && Number(marketDayStart(next, window.timeZone)) === +window.until;
}

function validComparison(report: ProductIntelligenceReport, previous?: ProductIntelligenceReport) {
  const expected = previousOpportunityWindow(report.window);
  const days = exactDays(report.window);
  return previous && expected && previous.marketId === report.marketId && previous.currency === report.currency && previous.test === report.test &&
    previous.window.timeZone === report.window.timeZone && previous.window.from === expected.from && previous.window.to === expected.to &&
    days >= 7 && days % 7 === 0 && completeWindow(report.window) && completeWindow(previous.window);
}

function rowName(row: ProductIntelligenceRow) {
  return row.variantName ? `${row.name} · ${row.variantName}` : row.name;
}

function rowKey(row: ProductIntelligenceRow) {
  return JSON.stringify([row.productId, row.variantId]);
}

function money(amount: bigint, market: MarketId) {
  const { currency, minorDigits } = getMarket(market);
  const scale = 10n ** BigInt(minorDigits);
  const value = amount < 0n ? -amount : amount;
  const fraction = minorDigits ? `.${String(value % scale).padStart(minorDigits, "0")}` : "";
  return `${currency} ${amount < 0n ? "−" : ""}${(value / scale).toLocaleString("en-US")}${fraction}`;
}

function dominant<T>(rows: readonly T[], label: (row: T) => string, count: (row: T) => number, total: number) {
  if (!total) return null;
  const top = rows.reduce<T | undefined>((current, next) => !current || count(next) > count(current) ? next : current, undefined);
  return top ? { label: label(top), share: count(top) / total } : null;
}

function comparableMix(row: ProductIntelligenceRow, reference: ProductIntelligenceRow) {
  const dominantPlacement = (value: ProductIntelligenceRow) => dominant(value.metrics.impressionsByPlacement, x => x.placement, x => x.count, value.metrics.impressions);
  const dominantCampaign = (value: ProductIntelligenceRow) => dominant(value.metrics.campaignVisits, x => x.source, x => x.viewers, value.metrics.viewers);
  const comparableShare = (left: { label: string; share: number } | null, right: { label: string; share: number } | null) =>
    left && right && left.label === right.label && Math.abs(left.share - right.share) <= 0.25;
  return comparableShare(dominantPlacement(row), dominantPlacement(reference)) && comparableShare(dominantCampaign(row), dominantCampaign(reference)) &&
    Math.abs(row.metrics.discountedUnits / Math.max(1, row.metrics.bookedUnits) - reference.metrics.discountedUnits / Math.max(1, reference.metrics.bookedUnits)) <= 0.20;
}

function constrained(row: ProductIntelligenceRow) {
  const { stockoutDays, partialDays, available, marketDelivery } = row.availability;
  return available === 0 || marketDelivery === false || stockoutDays > 0 || partialDays > 0;
}

function goodAvailability(row: ProductIntelligenceRow, periodDays: number) {
  return !constrained(row) && row.availability.availableDays >= periodDays * 0.75;
}

function bestMatchedProduct(term: string, products: ProductIntelligenceRow[]) {
  const words = (value: string): string[] => value.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const termWords = words(term);
  const matches = products.filter(product => !product.variantId && product.eligible).flatMap(product => {
    const productWords = words(product.name);
    const extra = termWords.filter(word => !productWords.includes(word));
    if (productWords.length < 2 || !productWords.every(word => termWords.includes(word)) || extra.length < 1 || extra.length > 3) return [];
    return { product, extra };
  });
  if (matches.length !== 1) return null;
  const [{ product, extra }] = matches;
  const variants = products.filter(row => row.productId === product.productId && row.variantName);
  if (!variants.length || variants.some(row => extra.every(word => words(row.variantName!).includes(word)))) return null;
  return product;
}

export function buildOpportunityAssessments(report: ProductIntelligenceReport, previous?: ProductIntelligenceReport): OpportunityAssessment[] {
  const output: OpportunityAssessment[] = [];
  const marketRows = report.products.filter(row => row.currency === report.currency);
  const productRows = marketRows.filter(row => !row.variantId);
  const previousRows = new Map(validComparison(report, previous) && previous
    ? previous.products.filter(row => row.currency === report.currency).map(row => [rowKey(row), row]) : []);
  const periodDays = exactDays(report.window);
  function add(fields: Omit<OpportunityAssessment, "marketId" | "productId" | "variantId" | "id" | "href">,
    row?: ProductIntelligenceRow) {
    const view = fields.kind === "availability" ? "forecast" : "overview";
    const id = stableMeasurementId("product-intelligence-opportunity-v1", report.marketId, report.test ? "test" : "live",
      report.window.from, report.window.to, fields.kind, row?.productId ?? "", row?.variantId ?? "", fields.term ?? "");
    output.push({ ...fields, id, marketId: report.marketId, productId: row?.productId, variantId: row?.variantId,
      href: intelligenceEvidenceHref(report, view, row?.productId, row?.variantId) });
  }

  for (const row of marketRows) {
    const { metrics, availability, finance } = row;
    const name = rowName(row);
    const prior = previousRows.get(rowKey(row));
    if (metrics.paidOrders >= 5 && metrics.paidUnits >= 5) {
      const profitable = finance.contributionMinor !== null && finance.contributionMinor > 0n && finance.completeOrders === finance.requiredOrders;
      add({ kind: "demonstrated-demand", signal: profitable ? "profitable-demand" : "demonstrated-demand", title: name,
        facts: [`${name} had ${studied(metrics.paidUnits, "units")} across ${studied(metrics.paidOrders, "verified completed orders")}.`,
          ...(profitable ? [`${money(finance.contributionMinor!, report.marketId)} in verified contribution for the selected order cohort.`] : [])],
        hypothesis: "Review placement and available stock before increasing exposure.",
        limitations: ["Completed orders reflect verified prepaid captures or COD collections. They may include promotion-led demand.",
          ...(!profitable ? ["Check complete costs and local contribution separately."] : [])],
        sample: metrics.paidOrders, confidence: metrics.paidOrders >= 20 && (profitable || goodAvailability(row, periodDays)) ? "strong" : "directional", action: "hold",
      }, row);
    }

    if (prior && metrics.paidOrders >= 5 && prior.metrics.paidOrders >= 3 && metrics.paidUnits >= Math.max(prior.metrics.paidUnits + 3, prior.metrics.paidUnits * 1.25) &&
        metrics.impressions >= 30 && prior.metrics.impressions >= 30 && goodAvailability(row, periodDays) && goodAvailability(prior, periodDays) &&
        comparableMix(row, prior) && metrics.paidUnits / metrics.impressions >= 1.2 * prior.metrics.paidUnits / prior.metrics.impressions) {
      const currentEff = number(Math.round(metrics.paidUnits * 1000 / metrics.impressions));
      const priorEff = number(Math.round(prior.metrics.paidUnits * 1000 / prior.metrics.impressions));
      add({ kind: "growing-demand", signal: "demonstrated-demand", title: name,
        facts: [`${name} had ${number(metrics.paidUnits)} verified paid units versus ${number(prior.metrics.paidUnits)} in ${previous!.window.from} through ${previous!.window.to}.`,
          `That is ${currentEff} versus ${priorEff} paid units per 1,000 observed impressions. Each window had stock observations on at least 75% of its days with no observed constraints.`],
        hypothesis: "Verify that the increase persists in the next comparable market window before expanding purchasing.",
        limitations: [missingCausality, "Adjacent market windows cover the same weekdays. Holidays, cross-device attribution, and traffic within a placement can still differ.", availabilityLimit],
        confidence: "directional", sample: metrics.paidOrders + prior.metrics.paidOrders, action: "investigate",
      }, row);
    }

    if (constrained(row) && (metrics.viewers >= 10 || metrics.cartSessions >= 3 || metrics.paidOrders >= 3)) {
      const constraints = [availability.available === 0 && "current available stock is zero", availability.marketDelivery === false && "the market has no enabled delivery coverage",
        availability.stockoutDays > 0 && `${studied(availability.stockoutDays, "observed stockout days")}`, availability.partialDays > 0 && `${studied(availability.partialDays, "partially available observed days")}`]
        .filter(Boolean).join(", ");
      add({ kind: "availability", signal: "operational", title: name,
        facts: [`${name} had ${studied(metrics.viewers, "distinct viewing journeys")}, ${studied(metrics.cartSessions, "cart sessions")} and ${studied(metrics.paidOrders, "verified completed orders")}.`,
          `Availability evidence shows ${constraints}.`],
        hypothesis: "Check assigned stock, market delivery configuration and lead time to see whether availability limits purchases.",
        limitations: [availabilityLimit, "Checkout evaluates eligibility for each delivery address."],
        sample: Math.max(metrics.viewers, metrics.cartSessions, metrics.paidOrders), confidence: "directional", action: "investigate",
      }, row);
    }

    if (finance.requiredOrders >= 3 && finance.completeOrders === finance.requiredOrders && finance.collectedMinor !== null && finance.collectedMinor > 0n &&
        finance.contributionMinor !== null && finance.contributionMinor <= 0n) {
      add({ kind: "contribution", signal: "operational", title: name,
        facts: [`${name} had ${money(finance.collectedMinor, report.marketId)} in verified collections for the reporting cohort.`,
          `Contribution was ${money(finance.contributionMinor, report.marketId)} across ${studied(finance.completeOrders, "orders with complete current costs")}.`],
        hypothesis: "Test whether price, fulfillment fees, returns or the recorded allocation explain the weak contribution before changing merchandising.",
        limitations: ["Product costs allocated from mixed orders depend on the accounting allocation method."],
        sample: finance.completeOrders, confidence: finance.completeOrders >= 20 ? "strong" : "directional", action: "investigate",
      }, row);
    }

    const cartRate = metrics.viewers >= 30 && metrics.viewedThenCart <= metrics.viewers ? metrics.viewedThenCart / metrics.viewers : null;
    if (cartRate === null || row.variantId || !row.eligible || constrained(row) || metrics.impressions < 30) continue;
    const peerRates = productRows.filter(peer => peer.productId !== row.productId && peer.departmentId === row.departmentId && peer.eligible &&
      !constrained(peer) && peer.metrics.viewers >= 30 && peer.metrics.impressions >= 30 && peer.metrics.viewedThenCart <= peer.metrics.viewers && comparableMix(row, peer))
      .map(peer => peer.metrics.viewedThenCart / peer.metrics.viewers).sort((a, b) => a - b);
    if (peerRates.length < 2) continue;
    const median = (peerRates[Math.floor((peerRates.length - 1) / 2)] + peerRates[Math.floor(peerRates.length / 2)]) / 2;
    if (median <= 0 || cartRate > median * 0.7 || median - cartRate < 0.05) continue;
    const interval = wilsonInterval(metrics.viewedThenCart, metrics.viewers)!;
    add({ kind: "conversion", signal: "interest", title: name,
      facts: [`${name} reached cart in ${studied(metrics.viewedThenCart, "linked journeys")} out of ${studied(metrics.viewers, "distinct viewing journeys")} (${percent(cartRate)}, approximate 95% interval ${percent(interval[0])} to ${percent(interval[1])}).`,
        `The median across ${studied(peerRates.length, "eligible same-department products")} with comparable observed placement, campaign and discount mix was ${percent(median)}.`],
      hypothesis: "Inspect product details, variant clarity, pricing and delivery information for friction between view and cart.",
      limitations: [checkoutLimit, availabilityLimit, missingCausality], sample: metrics.viewers, confidence: "directional", action: "investigate",
    }, row);
  }

  for (const query of report.searches.terms) {
    const term = safeSearchQuery(query.term);
    if (!term || query.searchers < 3 || query.zeroResults < 3 || query.zeroResults / Math.max(1, query.searches) < 0.5) continue;
    const zeroShare = query.zeroResults / query.searches;
    const facts = [`“${term}” had ${studied(query.searches, "searches")} from ${studied(query.searchers, "distinct searchers")}.`,
      `${studied(query.zeroResults, "searches")} returned zero results (${percent(zeroShare)}), with ${studied(query.reformulations, "subsequent reformulations")}.`];
    add({ kind: "unmet-search", signal: "interest", title: `Unmet search for “${term}”`, term, facts,
      hypothesis: "Check search aliases, listing metadata and eligible market inventory before treating this as an assortment gap.",
      limitations: [searchLimit], sample: query.searchers, confidence: query.searchers >= 8 ? "directional" : "limited", action: "investigate",
    });
    const variant = bestMatchedProduct(term, marketRows);
    if (variant) {
      add({ kind: "variant-gap", signal: "interest", title: `Possible variant gap for ${variant.name}`, term, facts,
        hypothesis: "Check the requested attribute against eligible variants and verify whether a search alias or a small variant test would help.",
        limitations: [searchLimit, "Verify variants and attributes in the catalog before acting on a name match."],
        sample: query.searchers, confidence: "limited", action: "test",
      }, variant);
    } else if (query.searchers >= 6 && zeroShare >= 0.75) {
      add({ kind: "test-candidate", signal: "interest", title: `Assortment test for “${term}”`, term, facts,
        hypothesis: "Draft a small product or category test after reviewing eligibility, comparable listings, supplier cost and attainable margins.",
        limitations: [searchLimit, "Measure purchase conversion and contribution during the proposed test."],
        sample: query.searchers, confidence: "directional", action: "test",
      });
    }
  }

  return output.sort((left, right) => right.sample - left.sample || left.id.localeCompare(right.id));
}
