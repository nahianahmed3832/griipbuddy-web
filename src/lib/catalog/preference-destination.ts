import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { localizedStorePath, withoutRegionalPrefix } from "../../config/regional-path.ts";
import { storefrontCookiePath, storefrontPath } from "../../config/storefront-path.ts";
import { secureCookies } from "../db/http.ts";
import { isMarketSelectable, marketConfiguration, marketIdInput, marketLanguage } from "../market-config.ts";
import { hybridDemoMode } from "../release-config.ts";
import { resolveConnectedCategory, resolveConnectedCollection } from "./connected-navigation.ts";

const preferenceInput = z.strictObject({
  marketId: marketIdInput,
  locale: z.string().max(35),
  fromMarketId: marketIdInput,
  fromLocale: z.string().max(35),
  path: z.string().max(4096),
});

export function preferenceCookie() {
  return { httpOnly: true, sameSite: "lax" as const, secure: secureCookies(), path: storefrontCookiePath, maxAge: 365 * 86400 };
}

function storefrontLocation(value: string) {
  const base = "http://storefront.invalid";
  if (!value.startsWith("/") || value.startsWith("//") || /[\u0000-\u0020\\]/u.test(value)) return null;
  const url = new URL(value, base);
  return url.origin === base && !url.pathname.startsWith("//") ? url : null;
}

function categoryRef(value: string) {
  try { return decodeURIComponent(value); } catch { return ""; }
}

export async function shoppingPreferenceDestination(raw: unknown): Promise<{ marketId: MarketId; locale: string; href: string } | null> {
  const parsed = preferenceInput.safeParse(raw);
  if (!parsed.success) return null;
  const { marketId, fromMarketId, path } = parsed.data;
  if (!isMarketSelectable(marketId) || !isMarketSelectable(fromMarketId)) return null;
  const locale = marketLanguage(marketConfiguration(marketId), parsed.data.locale);
  const fromLocale = marketLanguage(marketConfiguration(fromMarketId), parsed.data.fromLocale);
  const url = storefrontLocation(path);
  if (!locale || !fromLocale || !url) return null;

  const regional = hybridDemoMode();
  const bare = regional ? withoutRegionalPrefix(url.pathname) : url.pathname;
  if (bare.startsWith("//")) return null;
  const browse = /^\/(departments|collections)\/([^/]+)\/?$/.exec(bare);
  let target = bare;
  if (browse) {
    const [, kind, slug] = browse;
    const ref = categoryRef(slug);
    let targetSlug: string | undefined;
    if (kind === "departments") {
      const source = await resolveConnectedCategory(ref, fromMarketId, fromLocale);
      const category = source && await resolveConnectedCategory(source.category.id, marketId, locale);
      targetSlug = category?.category.localizedSlug;
    } else {
      const source = await resolveConnectedCollection(ref, undefined, fromMarketId);
      const collection = source && await resolveConnectedCollection(source.id, undefined, marketId);
      targetSlug = collection?.slug;
    }
    url.searchParams.delete("cursor");
    url.searchParams.delete("page");
    url.searchParams.delete("browseFrom");
    if (targetSlug) {
      target = `/${kind}/${encodeURIComponent(targetSlug)}`;
      if (fromMarketId !== marketId) url.searchParams.set("browseFrom", fromMarketId);
    } else {
      target = "/shop";
      url.search = "";
      url.hash = "";
      url.searchParams.set("catalogUnavailable", kind === "departments" ? "category" : "collection");
    }
    url.searchParams.set("market", marketId);
    url.searchParams.set("lang", locale);
  } else if (bare === "/search" || bare === "/search/" || bare === "/shop" || bare === "/shop/") {
    url.searchParams.delete("cursor");
    url.searchParams.delete("page");
    url.searchParams.delete("browseFrom");
    if (fromMarketId !== marketId) url.searchParams.set("browseFrom", fromMarketId);
    url.searchParams.set("market", marketId);
    url.searchParams.set("lang", locale);
  } else if (/^\/products\/[^/]+\/?$/.test(bare)) {
    url.searchParams.set("market", marketId);
    url.searchParams.set("lang", locale);
  } else {
    url.searchParams.delete("market");
    url.searchParams.delete("lang");
  }

  const href = storefrontPath(regional ? localizedStorePath(target, marketId) : target) + url.search + url.hash;
  return { marketId, locale, href };
}
