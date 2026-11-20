import { storefrontBasePath } from "../../config/storefront-path.ts";
import { privateHeaders } from "../db/http.ts";
import { reportFailure } from "../db/observability.ts";
import { getStaffFromHeaders } from "../staff/access.ts";
import { canUseMarket, staffMarketIds, type MarketStaffPermission } from "../staff/market-access.ts";
import { selectedMarketId } from "../market-config.ts";
import { mainAdminCatalogConfig, mainAdminCatalogRequested } from "./main-admin-config.ts";
import { getDb } from "../db/client.ts";
import { legacyProductScope, scopedCatalogPilotReady } from "./scoped-pilot.ts";

const responseHeaders = { ...privateHeaders, "X-Robots-Tag": "noindex, nofollow" };
const categoryPath = /^\/staff\/catalog\/taxonomy(?:\/legacy)?\/?$/;
const productPath = /^\/staff\/catalog\/products\/([^/]+)\/?$/;
const productListPath = /^\/staff\/catalog(?:\/products)?\/?$/;
const stockPath = /^\/staff\/catalog\/inventory\/?$/;
const connectedApiPath = /^\/api\/staff\/(?:catalog(?:\/|$)|product-image\/?$)/;
const pilotMerchandisingPage = /^\/staff\/catalog\/taxonomy\/?$/;
const pilotMerchandisingApi = /^\/api\/staff\/catalog(?:\/context)?\/?$/;

const boundedIdentifier = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/;
const locale = /^[a-zA-Z0-9-]{1,35}$/;
const queryText = /^[^\p{Cc}]{1,120}$/u;

function preserve(target: URL, source: Pick<URL, "searchParams">, name: string, pattern: RegExp) {
  const values = source.searchParams.getAll(name);
  if (values.length === 1 && pattern.test(values[0])) target.searchParams.set(name, values[0]);
}

type OldDestination = { path: string; permission: MarketStaffPermission; stock?: boolean; ownerOnly?: boolean };

function oldDestination(path: string): OldDestination | undefined {
  if (categoryPath.test(path)) return { path: "/admin/dashboard/categories", permission: "merchandising", ownerOnly: /\/legacy\/?$/.test(path) };
  if (stockPath.test(path)) return { path: "/admin/dashboard/check-outlet-stocks", permission: "commercial", stock: true };
  if (productListPath.test(path)) return { path: "/admin/dashboard/products", permission: "commercial" };
  const match = productPath.exec(path);
  if (match && /^[a-z0-9][a-z0-9-]{0,119}$/.test(match[1])) {
    if (match[1] === "new") return { path: "/admin/dashboard/create-product", permission: "commercial", ownerOnly: true };
    return { path: `/admin/dashboard/product-details/${encodeURIComponent(match[1])}`, permission: "commercial" };
  }
}

export async function retiredCatalogBrowserResponse(request: Request, input: Pick<URL, "pathname" | "searchParams">, fallbackMarket?: string) {
  let path: string;
  try { path = decodeURI(input.pathname); }
  catch { return; }
  const destination = oldDestination(path);
  const api = connectedApiPath.test(path);
  if (!destination && !api && !productPath.test(path)) return;
  if (!mainAdminCatalogRequested()) return;
  try {
    const staff = await getStaffFromHeaders(request.headers);
    if (!staff) return new Response(null, { status: 401, headers: responseHeaders });
    if (staff.role !== "OWNER" &&
        ((request.method === "GET" || request.method === "HEAD") && pilotMerchandisingPage.test(path) ||
          request.method === "POST" && pilotMerchandisingApi.test(path)) &&
        (await staffMarketIds(staff.id, "merchandising")).length > 0 && await scopedCatalogPilotReady()) return;
    if (staff.role === "OWNER" && await scopedCatalogPilotReady()) {
      const productId = productPath.exec(path)?.[1];
      const legacyEditor = input.searchParams.getAll("editor");
      const taxonomyView = input.searchParams.getAll("view");
      if (stockPath.test(path) || productListPath.test(path) ||
          categoryPath.test(path) && (!taxonomyView.length || taxonomyView.length === 1 && taxonomyView[0] === "categories") ||
          productId === "new" && legacyEditor.length === 1 && legacyEditor[0] === "legacy") return;
      if (productId && productId !== "new" && destination && await getDb().product.findFirst({
        where: { AND: [{ id: productId }, await legacyProductScope(getDb())] }, select: { id: true },
      })) return;
    }
    if (!destination && !api) return new Response(null, { status: 404, headers: responseHeaders });
    if (!destination || (request.method !== "GET" && request.method !== "HEAD")) {
      return Response.json({
        error: { code: "retired", message: "Open the main GriipBuddy admin to manage the catalog." },
      }, { status: 410, headers: responseHeaders });
    }
    const config = mainAdminCatalogConfig();
    if (!config) return new Response(null, { status: 503, headers: responseHeaders });
    const categorySelection = input.searchParams.getAll("category");
    const view = input.searchParams.getAll("view");
    const createCategory = categoryPath.test(path) && !destination.ownerOnly &&
      categorySelection.length === 1 && categorySelection[0] === "new" &&
      (!view.length || (view.length === 1 && view[0] === "categories"));
    if (((destination.ownerOnly || createCategory) && staff.role !== "OWNER") || ![...config.actors.values()].includes(staff.id)) {
      return new Response(null, { status: 403, headers: responseHeaders });
    }
    const queryMarket = input.searchParams.getAll("market");
    const requestedMarket = queryMarket.length === 1 && /^(?:bd|us)$/.test(queryMarket[0]) ? queryMarket[0] : undefined;
    const marketId = selectedMarketId(requestedMarket ?? fallbackMarket);
    if (!await canUseMarket(staff.id, marketId, destination.permission)) {
      return new Response(null, { status: 403, headers: responseHeaders });
    }
    const target = new URL(destination.path, config.origin);
    target.searchParams.set("region", marketId === "us" ? "INTERNATIONAL" : "BD");
    if (destination.stock) target.searchParams.set("catalog", "connected");
    preserve(target, input, "q", queryText);
    if (destination.permission === "merchandising") {
      if (createCategory) target.searchParams.set("mode", "create");
      else preserve(target, input, "category", boundedIdentifier);
      preserve(target, input, "view", /^(?:categories|navigation|collections)$/);
      if (target.searchParams.get("view") === "navigation") target.searchParams.set("view", "menus");
      preserve(target, input, "collection", boundedIdentifier);
      preserve(target, input, "menuKey", boundedIdentifier);
      preserve(target, input, "menuLocale", locale);
      preserve(target, input, "scope", /^(?:direct|descendants|all|search)$/);
    } else {
      preserve(target, input, "source", /^(?:connected|legacy)$/);
      preserve(target, input, "state", /^(?:DRAFT|ACTIVE|ARCHIVED)$/);
      if (productListPath.test(path) && staff.role === "OWNER" && requestedMarket === marketId) {
        target.searchParams.set("offerMarket", marketId);
      }
    }
    preserve(target, input, "page", /^[1-9][0-9]{0,3}$/);
    return new Response(null, { status: 307, headers: { ...responseHeaders, Location: target.href } });
  } catch (error) {
    reportFailure("main-admin.catalog.redirect", undefined, error);
    return new Response(null, { status: 503, headers: responseHeaders });
  }
}

export function retiredCatalogApiResponse(request: Request) {
  const url = new URL(request.url);
  const pathname = storefrontBasePath && url.pathname.startsWith(`${storefrontBasePath}/`)
    ? url.pathname.slice(storefrontBasePath.length) : url.pathname;
  return retiredCatalogBrowserResponse(request, { pathname, searchParams: url.searchParams });
}
