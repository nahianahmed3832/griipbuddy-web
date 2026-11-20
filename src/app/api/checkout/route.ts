import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { currentMarket } from "@/lib/market-server";
import { checkoutDestination } from "@/lib/commerce/market-commerce";
import { guestCookie, guestMaxAge, newGuestToken, readGuestKey } from "@/lib/commerce/guest";
import { recoverCheckout, reviewCheckout, submitCheckout } from "@/lib/commerce/orders";
import { integratedCheckout, recoverRecovered, reviewRecovered, submitRecovered } from "@/lib/commerce/integrated-checkout";
import { privateHeaders, readJson, sameOrigin, secureCookies } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure, requestId } from "@/lib/db/observability";
import { storefrontCookiePath } from "@/config/storefront-path";
import { hasStaffMeasurementSession, measurementCookie, measurementSessionHeader } from "@/lib/measurement/server";
import { provisionBridgeHandoff } from "@/lib/measurement/bridge-consent";
import { getShopper } from "@/lib/marketplace/auth";
import { submissionInput, uuid } from "@/lib/commerce/checkout-types";
import { measureCheckout } from "@/lib/measurement/checkout";

const requestBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("review"), checkout: z.unknown() }),
  z.object({ action: z.literal("submit"), checkout: z.unknown() }),
  z.object({ action: z.literal("recover"), attemptId: z.unknown() }),
]);

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ kind: "invalid", message: "Open checkout from this storefront." }, { status: 403, headers: privateHeaders });
  }

  const parsed = requestBody.safeParse(await readJson(request));
  if (!parsed.success) {
    return NextResponse.json({ kind: "invalid", message: "Checkout data is incomplete or too large." }, { status: 400, headers: privateHeaders });
  }

  const cookieStore = await cookies();
  const action = parsed.data;
  const reference = requestId();
  try {
    const marketId = checkoutDestination(request.headers, (await currentMarket()).id);
    if (!marketId) return NextResponse.json({ kind: "invalid", message: "Choose a configured shopping market." }, {
      status: 422, headers: privateHeaders,
    });
    let guestKey = readGuestKey(cookieStore.get(guestCookie)?.value);
    const ip = clientKey(request.headers);
    if (!await consumeQuota(`checkout.${action.action}.ip`, ip, 90, 600) ||
        (guestKey && !await consumeQuota(`checkout.${action.action}.guest`, guestKey, 24, 600))) {
      return NextResponse.json({ kind: "error", message: "Too many checkout requests. Wait a few minutes and try again." }, {
        status: 429, headers: { ...privateHeaders, "Retry-After": "600" },
      });
    }
    let token: string | undefined;
    if (!guestKey) {
      if (action.action !== "review") {
        return NextResponse.json({ kind: "conflict", message: "This browser no longer has the original checkout session." }, { status: 409, headers: privateHeaders });
      }
      token = newGuestToken();
      guestKey = readGuestKey(token)!;
    }

    const recovered = integratedCheckout(marketId);
    const result = action.action === "recover"
      ? await (recovered ? recoverRecovered(action.attemptId, guestKey) : recoverCheckout(action.attemptId, guestKey, marketId))
      : action.action === "review"
        ? await (recovered ? reviewRecovered : reviewCheckout)(action.checkout, marketId, guestKey)
        : recovered ? await submitRecovered(action.checkout, marketId, guestKey, lines => provisionBridgeHandoff({
          headers: request.headers, consentCookie: cookieStore.get(measurementCookie)?.value,
          sessionId: request.headers.get(measurementSessionHeader) ?? undefined, marketId, lines,
        }).catch(error => {
          reportFailure("measurement.legacy-handoff", reference, error);
          return null;
        }))
          : await submitCheckout(action.checkout, marketId, guestKey, (await getShopper())?.id, hasStaffMeasurementSession(request.headers));
    const status = result.kind === "conflict" || result.kind === "changed" ? 409
      : result.kind === "invalid" || result.kind === "unavailable" ? 422 : 200;
    const response = NextResponse.json(result, { status, headers: privateHeaders });
    if (token && result.kind === "review") {
      response.cookies.set(guestCookie, token, {
        httpOnly: true, sameSite: "lax", secure: secureCookies(), path: storefrontCookiePath, maxAge: guestMaxAge,
      });
    }
    if (!recovered && (result.kind === "review" || result.kind === "placed")) {
      const attemptId = result.kind === "review" ? result.attemptId
        : action.action === "recover" ? uuid.safeParse(action.attemptId).data
          : action.action === "submit" ? submissionInput.safeParse(action.checkout).data?.attemptId : undefined;
      measureCheckout(request, cookieStore.get(measurementCookie)?.value, {
        marketId, guestKey, reference, attemptId, orderId: result.kind === "placed" ? result.orderId : undefined,
      });
    }
    return response;
  } catch (error) {
    reportFailure(`checkout.${action.action}`, reference, error);
    return NextResponse.json({ kind: "error", message: `The store couldn’t complete that request. Please try again. Reference ${reference}.` }, {
      status: 503, headers: { ...privateHeaders, "X-Request-Id": reference },
    });
  }
}
