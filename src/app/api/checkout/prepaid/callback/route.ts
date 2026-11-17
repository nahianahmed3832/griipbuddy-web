import { NextResponse } from "next/server";
import { storefrontPath } from "@/config/storefront-path";
import { acceptPrepaidCallback } from "@/lib/commerce/prepaid-checkout";
import { prepaidConfig } from "@/lib/commerce/prepaid-config";
import { privateHeaders, readBody } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { hybridStoreMode } from "@/lib/release-config";

export async function POST(request: Request) {
  const config = prepaidConfig();
  if (!config) return new Response(null, { status: 404, headers: privateHeaders });
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) {
    return new Response(null, { status: 400, headers: privateHeaders });
  }
  const body = await readBody(request, 16_384);
  if (!body) return new Response(null, { status: 400, headers: privateHeaders });
  const fields = new URLSearchParams(body.toString("utf8"));
  const providerId = fields.get("tran_id");
  if (!providerId || !/^GB[0-9a-f]{26}$/.test(providerId)) return new Response(null, { status: 400, headers: privateHeaders });
  const isNotification = new URL(request.url).searchParams.get("flow") === "notify";
  try {
    if (!await consumeQuota("prepaid.callback", providerId, 18, 120)) return new Response(null, { status: 429, headers: privateHeaders });
    const attemptId = await acceptPrepaidCallback(providerId, fields.get("val_id") ?? undefined);
    if (!attemptId) return new Response(null, { status: 404, headers: privateHeaders });
    if (isNotification) return new Response(null, { status: 200, headers: privateHeaders });
    const checkout = new URL(storefrontPath(hybridStoreMode() ? "/bd/checkout" : "/checkout"), config.origin);
    checkout.searchParams.set("destination", "bd");
    checkout.searchParams.set("prepaid", attemptId);
    return NextResponse.redirect(checkout, { status: 303, headers: privateHeaders });
  } catch (error) {
    reportFailure("prepaid.callback", undefined, error);
    // Providers can retry notifications and shoppers can recover from their saved cart.
    return new Response(null, { status: 503, headers: privateHeaders });
  }
}
