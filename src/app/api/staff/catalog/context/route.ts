import { NextResponse } from "next/server";
import { z } from "zod";
import { marketCookie } from "@/config/markets";
import { storefrontCookiePath } from "@/config/storefront-path";
import { retiredCatalogApiResponse } from "@/lib/catalog/main-admin-browser";
import { mainAdminCatalogRequested } from "@/lib/catalog/main-admin-config";
import { privateHeaders, readJson, sameOrigin, secureCookies } from "@/lib/db/http";
import { isMarketSelectable, marketIdInput } from "@/lib/market-config";
import { getStaffFromHeaders } from "@/lib/staff/access";
import { canUseMarket } from "@/lib/staff/market-access";

const input = z.strictObject({ marketId: marketIdInput, permission: z.enum(["merchandising", "commercial"]).default("merchandising") });
const failure = (status: number, error: string) => Response.json({ error: { message: error } }, { status, headers: privateHeaders });

export async function POST(request: Request) {
  const retired = await retiredCatalogApiResponse(request);
  if (retired) return retired;
  if (!sameOrigin(request)) return failure(403, "Select a market from the staff catalog.");
  const staff = await getStaffFromHeaders(request.headers);
  if (!staff) return failure(401, "Sign in to select a market.");
  const data = input.safeParse(await readJson(request, 1024)).data;
  if (!data || !isMarketSelectable(data.marketId)) return failure(400, "Choose a browsable market.");
  if (mainAdminCatalogRequested() && data.permission !== "merchandising") return failure(403, "Choose a merchandising market.");
  if (!await canUseMarket(staff.id, data.marketId, data.permission)) return failure(403, "You do not have access to this market.");

  const response = NextResponse.json({ data: { marketId: data.marketId } }, { headers: privateHeaders });
  response.cookies.set(marketCookie, data.marketId, {
    path: storefrontCookiePath, httpOnly: true, secure: secureCookies(), sameSite: "lax", maxAge: 365 * 86400,
  });
  return response;
}
