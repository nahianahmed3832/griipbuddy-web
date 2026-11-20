import { NextResponse } from "next/server";
import { storefrontPath } from "@/config/storefront-path";
import { acceptPrepaidCallback, PrepaidCallbackIdentityError } from "@/lib/commerce/prepaid-checkout";
import { prepaidConfig } from "@/lib/commerce/prepaid-config";
import { privateHeaders, readBody } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { hybridStoreMode } from "@/lib/release-config";
import { localizedStorePath } from "@/config/regional-path";

export async function POST(request: Request) {
  const config = prepaidConfig();
  if (!config) return new Response(null, { status: 404, headers: privateHeaders });
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return new Response(null, { status: 400, headers: privateHeaders });
  }
  const body = await readBody(request, 16_384);
  if (!body) return new Response(null, { status: 400, headers: privateHeaders });
  const fields = new URLSearchParams(body.toString("utf8"));
  if (fields.getAll("tran_id").length !== 1 || fields.getAll("val_id").length > 1) {
    return new Response(null, { status: 400, headers: privateHeaders });
  }
  const providerId = fields.get("tran_id");
  if (!providerId || !/^GB[0-9a-f]{26}$/.test(providerId)) return new Response(null, { status: 400, headers: privateHeaders });
  const isNotification = new URL(request.url).searchParams.get("flow") === "notify";
  try {
    if (!await consumeQuota(`prepaid.${config.marketId}.callback`, providerId, 18, 120)) return new Response(null, { status: 429, headers: privateHeaders });
    const attemptId = await acceptPrepaidCallback(providerId, fields.get("val_id") ?? undefined);
    if (!attemptId) return new Response(null, { status: 404, headers: privateHeaders });
    if (isNotification) return new Response(null, { status: 200, headers: privateHeaders });
    const checkout = new URL(storefrontPath(hybridStoreMode() ? localizedStorePath("/checkout", config.marketId) : "/checkout"), config.origin);
    checkout.searchParams.set("destination", config.marketId);
    checkout.searchParams.set("prepaid", attemptId);
    return NextResponse.redirect(checkout, { status: 303, headers: privateHeaders });
  } catch (error) {
    if (error instanceof PrepaidCallbackIdentityError) return new Response(null, { status: 403, headers: privateHeaders });
    reportFailure("prepaid.callback", undefined, error);
    // Providers can retry notifications and shoppers can recover from their saved cart.
    return new Response(null, { status: 503, headers: privateHeaders });
  }
}
