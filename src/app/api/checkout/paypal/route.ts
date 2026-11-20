import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { storefrontCookiePath } from "@/config/storefront-path";
import { uuid } from "@/lib/commerce/checkout-types";
import { CommerceError } from "@/lib/commerce/errors";
import { guestCookie, guestMaxAge, newGuestToken, readGuestKey } from "@/lib/commerce/guest";
import { createPayPalCheckout, paypalQuote, recoverPayPalCheckout } from "@/lib/commerce/paypal-checkout";
import { paypalSandboxConfig } from "@/lib/commerce/paypal-config";
import { checkoutDestination } from "@/lib/commerce/market-commerce";
import { privateHeaders, readJson, sameOrigin, secureCookies } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure, requestId } from "@/lib/db/observability";
import { getShopper } from "@/lib/marketplace/auth";
import { measureCheckout } from "@/lib/measurement/checkout";
import { measurementCookie } from "@/lib/measurement/server";

const requestBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("quote"), checkout: z.unknown() }),
  z.strictObject({ action: z.literal("create"), checkout: z.unknown(), attemptId: uuid, quoteToken: z.string().regex(/^[a-f0-9]{64}$/) }),
  z.strictObject({ action: z.literal("capture"), attemptId: uuid }),
  z.strictObject({ action: z.literal("recover"), attemptId: uuid }),
  z.strictObject({ action: z.literal("cancel"), attemptId: uuid }),
]);

function json(data: object, status = 200) {
  return NextResponse.json(data, { status, headers: privateHeaders });
}

export async function POST(request: Request) {
  const config = paypalSandboxConfig();
  if (!config) return json({ kind: "unavailable", message: "Test checkout is unavailable." }, 404);
  if (!sameOrigin(request)) return json({ kind: "invalid", message: "Open checkout from this storefront." }, 403);
  const marketId = checkoutDestination(request.headers, config.marketId);
  if (marketId !== config.marketId) return json({ kind: "invalid", message: "Select a market with this checkout method." }, 422);
  const parsed = requestBody.safeParse(await readJson(request));
  if (!parsed.success) return json({ kind: "invalid", message: "Checkout data is incomplete or too large." }, 400);
  const action = parsed.data;
  const reference = requestId();

  try {
    const jar = await cookies();
    const existingGuest = readGuestKey(jar.get(guestCookie)?.value);
    const ipLimit = action.action === "quote" ? 90 : 24;
    if (!await consumeQuota(`paypal.${marketId}.${action.action}.ip`, clientKey(request.headers), ipLimit, 600) ||
        (existingGuest && !await consumeQuota(`paypal.${marketId}.${action.action}.guest`, existingGuest, 18, 600))) {
      return json({ kind: "error", message: "Too many checkout requests. Wait a few minutes and try again." }, 429);
    }
    if (action.action !== "quote" && !existingGuest) {
      return json({ kind: "conflict", message: "This browser no longer has the original checkout session." }, 409);
    }
    const token = existingGuest ? undefined : newGuestToken();
    const guestKey = existingGuest ?? readGuestKey(token);
    if (!guestKey) throw new Error("Checkout session could not be initialized.");
    const result = action.action === "quote"
      ? await paypalQuote(action.checkout, guestKey, marketId)
      : action.action === "create"
        ? await createPayPalCheckout(action.checkout, action.attemptId, action.quoteToken, guestKey, (await getShopper())?.id, marketId)
        : await recoverPayPalCheckout(action.attemptId, guestKey, action.action, marketId);
    const status = result.kind === "conflict" ? 409 : result.kind === "invalid" || result.kind === "unavailable" ? 422 : 200;
    const response = json(result, status);
    if (token && result.kind === "quoted") response.cookies.set(guestCookie, token, {
      httpOnly: true, sameSite: "lax", secure: secureCookies(), path: storefrontCookiePath, maxAge: guestMaxAge,
    });
    if (action.action !== "quote" && (result.kind === "approval_required" || result.kind === "pending" || result.kind === "placed")) {
      measureCheckout(request, jar.get(measurementCookie)?.value, {
        marketId, guestKey, reference, attemptId: action.attemptId, orderId: result.kind === "placed" ? result.orderId : undefined,
      });
    }
    return response;
  } catch (error) {
    if (error instanceof CommerceError) return json(error.detail, 422);
    reportFailure(`paypal.${action.action}`, reference, error);
    return json({ kind: "error", message: `Couldn’t confirm the PayPal request. Check payment status before trying again. Reference ${reference}.` }, 503);
  }
}
