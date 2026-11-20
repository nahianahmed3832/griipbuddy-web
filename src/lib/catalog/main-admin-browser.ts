import { privateHeaders } from "../db/http.ts";
import { reportFailure } from "../db/observability.ts";
import { getStaffFromHeaders } from "../staff/access.ts";
import { canUseMarket, type MarketStaffPermission } from "../staff/market-access.ts";
import { selectedMarketId } from "../market-config.ts";
import { mainAdminCatalogConfig } from "./main-admin-config.ts";

const responseHeaders = { ...privateHeaders, "X-Robots-Tag": "noindex, nofollow" };
const categoryPath = /^\/staff\/catalog\/taxonomy(?:\/legacy)?\/?$/;
const productPath = /^\/staff\/catalog\/products\/([^/]+)\/?$/;
const productListPath = /^\/staff\/catalog(?:\/products)?\/?$/;
const stockPath = /^\/staff\/catalog\/inventory\/?$/;
const connectedApiPath = /^\/api\/staff\/(?:catalog(?:\/|$)|product-image\/?$)/;

const boundedIdentifier = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/;
const locale = /^[a-zA-Z0-9-]{1,35}$/;
const queryText = /^[^\p{Cc}]{1,120}$/u;

function preserve(target: URL, source: Pick<URL, "searchParams">, name: string, pattern: RegExp) {
  const values = source.searchParams.getAll(name);
  if (values.length === 1 && pattern.test(values[0])) target.searchParams.set(name, values[0]);
}

type OldDestination = { path: string; permission: MarketStaffPermission; stock?: boolean };

function oldDestination(path: string): OldDestination | undefined {
  if (categoryPath.test(path)) return { path: "/admin/dashboard/categories", permission: "merchandising" };
  if (stockPath.test(path)) return { path: "/admin/dashboard/check-outlet-stocks", permission: "commercial", stock: true };
  if (productListPath.test(path)) return { path: "/admin/dashboard/products", permission: "commercial" };
  const match = productPath.exec(path);
  if (match && /^[a-z0-9][a-z0-9-]{0,119}$/.test(match[1])) return { path: match[1] === "new" ? "/admin/dashboard/create-product"
    : `/admin/dashboard/product-details/${encodeURIComponent(match[1])}`, permission: "commercial" };
}

export async function retiredCatalogBrowserResponse(request: Request, input: Pick<URL, "pathname" | "searchParams">, fallbackMarket?: string) {
  let path: string;
  try { path = decodeURI(input.pathname); }
  catch { return; }
  const destination = oldDestination(path);
  const api = connectedApiPath.test(path);
  if (!destination && !api && !productPath.test(path)) return;
  const config = mainAdminCatalogConfig();
  if (!config) return;
  try {
    const staff = await getStaffFromHeaders(request.headers);
    if (!staff) return new Response(null, { status: 401, headers: responseHeaders });
    if (!destination && !api) return new Response(null, { status: 404, headers: responseHeaders });
    const queryMarket = input.searchParams.getAll("market");
    const marketId = selectedMarketId(queryMarket.length === 1 && /^(?:bd|us)$/.test(queryMarket[0]) ? queryMarket[0] : fallbackMarket);
    if (destination && !await canUseMarket(staff.id, marketId, destination.permission)) {
      return new Response(null, { status: 403, headers: responseHeaders });
    }
    if (!destination || (request.method !== "GET" && request.method !== "HEAD")) {
      return Response.json({
        error: { code: "retired", message: "Open the main GriipBuddy admin to manage the catalog." },
      }, { status: 410, headers: responseHeaders });
    }
    const target = new URL(destination.path, config.origin);
    target.searchParams.set("region", marketId === "us" ? "INTERNATIONAL" : "BD");
    if (destination.stock) target.searchParams.set("catalog", "connected");
    preserve(target, input, "q", queryText);
    if (destination.permission === "merchandising") {
      preserve(target, input, "category", boundedIdentifier);
      preserve(target, input, "view", /^(?:categories|navigation|collections)$/);
      if (target.searchParams.get("view") === "navigation") target.searchParams.set("view", "menus");
      preserve(target, input, "collection", boundedIdentifier);
      preserve(target, input, "menuKey", boundedIdentifier);
      preserve(target, input, "menuLocale", locale);
      preserve(target, input, "scope", /^(?:direct|descendants|all|search)$/);
    } else {
      preserve(target, input, "source", /^(?:connected|legacy)$/);
      preserve(target, input, "state", /^(?:DRAFT|ACTIVE|ARCHIVED)$/);
    }
    preserve(target, input, "page", /^[1-9][0-9]{0,3}$/);
    return new Response(null, { status: 307, headers: { ...responseHeaders, Location: target.href } });
  } catch (error) {
    reportFailure("main-admin.catalog.redirect", undefined, error);
    return new Response(null, { status: 503, headers: responseHeaders });
  }
}
