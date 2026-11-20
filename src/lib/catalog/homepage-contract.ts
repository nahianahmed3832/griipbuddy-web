import { z } from "zod";
import { isMarketId, markets, type Currency, type MarketId } from "../../config/markets.ts";
import { localMarketTime } from "../market-calendar.ts";
import { recommendationPolicyInput } from "./recommendation-policy.ts";

export const sectionTypes = ["BANNER", "CURATED", "COLLECTION", "BESTSELLERS", "TRENDING", "RECENTLY_VIEWED", "RELATED",
  "DEPARTMENTS", "COLLECTIONS", "NEW", "FEATURED", "DEALS", "CATEGORY_SPOTLIGHT", "TILES", "BENEFITS"] as const;
export const featuredCampaigns = ["home-banner", "home-curated", "home-bestsellers", "home-trending", "home-similar"] as const;
const sectionKey = z.string().regex(/^[a-z][a-z0-9-]{0,38}$/);
const catalogId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/);
const catalogIds = z.array(catalogId).max(16);
const collectionSlug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,100}$/);
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).refine(value => {
  const date = new Date(value + ":00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === value;
});
const browseLink = z.string().max(190).regex(/^\/(?:shop|gifts|collections\/[a-z0-9-]+|departments\/[a-z0-9-]+|products\/[a-z0-9-]+)$/);
const bannerAsset = z.string().max(140).regex(/^\/(?:catalog|editorial|media)\/[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9]+)?$/);
const currency = z.custom<Currency>(value => Object.values(markets).some(market => market.currency === value), "Choose a configured currency.");

const benefitInput = z.strictObject({
  title: z.string().trim().min(2).max(70),
  description: z.string().trim().min(2).max(200),
  destination: z.enum(["delivery", "returns", "privacy", "terms"]).optional(),
});
const tileLayoutInput = z.enum(["SHORTCUTS", "PORTRAIT", "SHOWCASE", "DISCOVERY"]);
const editorialImage = z.strictObject({ src: bannerAsset, alt: z.string().trim().max(130) });
const tileImage = editorialImage.extend({ alt: z.string().trim().min(1).max(130) });
const focalPoint = z.strictObject({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) });
const tileInput = z.strictObject({
  key: sectionKey, kind: z.enum(["CATEGORY", "COLLECTION", "PRODUCT"]), referenceId: catalogId,
  title: z.string().trim().min(2).max(90).optional(),
  ctaLabel: z.string().trim().min(2).max(40).optional(),
  image: tileImage.optional(), mobileImage: tileImage.optional(),
  focalPoint: focalPoint.optional(), mobileFocalPoint: focalPoint.optional(),
});
export type HomepageTileLayout = z.infer<typeof tileLayoutInput>;
export type HomepageTile = z.infer<typeof tileInput>;
const tileLayouts = {
  SHORTCUTS: ["CATEGORY", "COLLECTION"],
  PORTRAIT: ["CATEGORY", "COLLECTION"],
  SHOWCASE: ["COLLECTION"],
  DISCOVERY: ["CATEGORY", "COLLECTION", "PRODUCT"],
} satisfies Record<HomepageTileLayout, readonly HomepageTile["kind"][]>;

const sectionInput = z.strictObject({
  key: sectionKey, type: z.enum(sectionTypes), title: z.string().trim().min(2).max(90),
  description: z.string().trim().max(300).optional(),
  position: z.int().min(1).max(100),
  enabled: z.boolean().optional(),
  productIds: catalogIds.optional(),
  categoryId: catalogId.optional(),
  categoryIds: catalogIds.optional(),
  collectionIds: catalogIds.optional(),
  collection: collectionSlug.optional(),
  fallbackIds: catalogIds.optional(),
  budget: z.strictObject({ currency, amountMinor: z.int().positive().max(2_147_483_647) }).optional(),
  startsLocal: localTime.optional(), endsLocal: localTime.optional(),
  limit: z.int().min(1).max(12).optional(),
  bannerImage: editorialImage.optional(),
  link: z.strictObject({ label: z.string().trim().min(2).max(40), href: browseLink }).optional(),
  tileLayout: tileLayoutInput.optional(),
  tiles: z.array(tileInput).min(1).max(12).optional(),
  benefits: z.array(benefitInput).min(1).max(6).optional(),
}).superRefine((section, ctx) => {
  if (section.type === "CURATED" && !section.productIds?.length) {
    ctx.addIssue({ code: "custom", path: ["productIds"], message: "Supply at least one active catalog product ID." });
  }
  if (section.type === "BENEFITS" && !section.benefits) {
    ctx.addIssue({ code: "custom", path: ["benefits"], message: "Add at least one service benefit." });
  }
  if (section.type === "COLLECTION" && !section.collection) {
    ctx.addIssue({ code: "custom", path: ["collection"], message: "Supply the catalog collection slug." });
  }
  if (section.type === "CATEGORY_SPOTLIGHT" && !section.categoryId) {
    ctx.addIssue({ code: "custom", path: ["categoryId"], message: "Choose the category to spotlight." });
  }
  for (const [key, allowed] of [
    ["categoryId", "CATEGORY_SPOTLIGHT"], ["categoryIds", "DEPARTMENTS"], ["collectionIds", "COLLECTIONS"], ["budget", "DEALS"],
    ["tileLayout", "TILES"], ["tiles", "TILES"], ["benefits", "BENEFITS"],
  ] as const) {
    if (section[key] !== undefined && section.type !== allowed) {
      ctx.addIssue({ code: "custom", path: [key], message: "This field does not apply to the section type." });
    }
  }
  if (section.type === "TILES") {
    if (!section.tileLayout || !section.tiles) {
      ctx.addIssue({ code: "custom", path: ["tiles"], message: "Choose a tile layout and add at least one catalog destination." });
    } else {
      const allowed: readonly HomepageTile["kind"][] = tileLayouts[section.tileLayout];
      const keys = new Set<string>();
      const destinations = new Set<string>();
      for (const [index, tile] of section.tiles.entries()) {
        const destination = `${tile.kind}:${tile.referenceId}`;
        if (keys.has(tile.key) || destinations.has(destination)) {
          ctx.addIssue({ code: "custom", path: ["tiles", index], message: "Use each tile key and catalog destination once per section." });
        }
        if (!allowed.includes(tile.kind)) {
          ctx.addIssue({ code: "custom", path: ["tiles", index, "kind"], message: "This destination type does not apply to the selected layout." });
        }
        keys.add(tile.key);
        destinations.add(destination);
      }
    }
  }
  if (section.startsLocal && section.endsLocal && section.startsLocal >= section.endsLocal) {
    ctx.addIssue({ code: "custom", path: ["endsLocal"], message: "The end time must follow the start." });
  }
});

export const homepageInput = z.strictObject({
  sections: z.array(sectionInput).max(16),
  hiddenSections: z.array(sectionKey).max(16).default([]),
  recommendations: recommendationPolicyInput.optional(),
}).superRefine((content, ctx) => {
  const keys = content.sections.map(section => section.key);
  if (new Set(keys).size !== keys.length || new Set(content.hiddenSections).size !== content.hiddenSections.length ||
      content.hiddenSections.some(key => keys.includes(key))) {
    ctx.addIssue({ code: "custom", path: ["sections"], message: "Use each section key once, either in the layout or in the hidden list." });
  }
});

export type HomepageSection = z.infer<typeof sectionInput>;
export const homepageSectionPlacements = {
  BANNER: "home-banner", CURATED: "home-curated", COLLECTION: "home-collections", COLLECTIONS: "home-collections",
  BESTSELLERS: "home-bestsellers", TRENDING: "home-trending", RECENTLY_VIEWED: "home-recently-viewed", RELATED: "home-similar",
  DEPARTMENTS: "home-departments", NEW: "home-new-arrivals", FEATURED: "home-featured", DEALS: "home-deals",
  CATEGORY_SPOTLIGHT: "home-category-spotlight", TILES: "home-merchandising-tiles", BENEFITS: "home-merchandising-tiles",
} as const satisfies Record<HomepageSection["type"], string>;

export function homepageTileImages(section: HomepageSection) {
  if (section.type !== "TILES") return [];
  return [section.bannerImage, ...section.tiles?.flatMap(tile => [tile.image, tile.mobileImage]) ?? []].filter(image => image !== undefined);
}
export type HomepageContentData = z.infer<typeof homepageInput>;
export type HomepageScope = { marketId?: MarketId; locale?: string };

function isCanonicalLocale(value: string | undefined) {
  try { return Boolean(value && value.length <= 35 && Intl.getCanonicalLocales(value)[0] === value); } catch { return false; }
}
export const scopeKey = (scope: HomepageScope) => `${scope.marketId ?? "global"}:${scope.locale ?? "default"}`;

export function parseHomepageScope(value: unknown): HomepageScope | null {
  if (typeof value !== "string") return null;
  const [marketId, locale, extra] = value.split(":");
  if (extra !== undefined || (marketId !== "global" && !isMarketId(marketId)) || (locale !== "default" && !isCanonicalLocale(locale))) return null;
  return { marketId: marketId === "global" ? undefined : marketId, locale: locale === "default" ? undefined : locale };
}

export const homepageLayers = (marketId: MarketId, locale: string): HomepageScope[] => [
  {}, { locale }, { marketId }, { marketId, locale },
];

export const defaultHomepage: HomepageContentData = {
  sections: [
    { key: "hero", type: "BANNER", title: "Essentials for every day", position: 1, limit: 2,
      productIds: ["p-tote", "p-notebooks"] },
    { key: "departments", type: "DEPARTMENTS", title: "Shop by department", position: 2 },
    { key: "collections", type: "COLLECTIONS", title: "Curated collections", position: 3 },
    { key: "new", type: "NEW", title: "New arrivals", position: 4, link: { label: "View all", href: "/collections/new-arrivals" } },
    { key: "featured", type: "FEATURED", title: "Featured picks", position: 5, link: { label: "View all", href: "/collections/featured" } },
    { key: "bestsellers", type: "BESTSELLERS", title: "Bestsellers", position: 6 },
    { key: "trending", type: "TRENDING", title: "Trending in your market", position: 7 },
    { key: "recent", type: "RECENTLY_VIEWED", title: "Recently viewed", position: 8 },
    { key: "similar", type: "RELATED", title: "Similar to what you viewed", position: 9 },
  ],
  hiddenSections: [],
};

export function mergeHomepage(layers: readonly HomepageContentData[]): HomepageSection[] {
  const sections = new Map<string, HomepageSection>();
  for (const layer of layers) {
    for (const key of layer.hiddenSections) sections.delete(key);
    for (const section of layer.sections) sections.set(section.key, section);
  }
  return [...sections.values()].sort((a, b) => a.position - b.position || a.key.localeCompare(b.key));
}

export function visibleHomepageSection(section: Pick<HomepageSection, "startsLocal" | "endsLocal">, at: Date, timeZone: string) {
  const start = section.startsLocal && localMarketTime(section.startsLocal, timeZone);
  const end = section.endsLocal && localMarketTime(section.endsLocal, timeZone);
  return (!section.startsLocal || Boolean(start && at >= start)) && (!section.endsLocal || Boolean(end && at < end));
}

export function activeHomepageSections(layers: readonly HomepageContentData[], at: Date, timeZone: string) {
  const sections = mergeHomepage(layers.map(layer => ({
    ...layer, sections: layer.sections.filter(section => visibleHomepageSection(section, at, timeZone)),
  }))).filter(section => section.enabled !== false);
  const hero = sections.find(section => section.key === "hero" && section.type === "BANNER");
  return hero ? [hero, ...sections.filter(section => section !== hero)] : sections;
}
