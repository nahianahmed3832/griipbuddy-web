import { cookies } from "next/headers";
import { NextResponse, after } from "next/server";
import { z } from "zod";
import { currentMarket, storefrontMarketAllowed } from "@/lib/market-server";
import { marketplaceMode } from "@/lib/release-config";
import { guestCookie, guestMaxAge, newGuestToken, readGuestKey } from "@/lib/commerce/guest";
import { recoverCheckout, reviewCheckout, submitCheckout } from "@/lib/commerce/orders";
import { integratedCheckout, recoverRecovered, reviewRecovered, submitRecovered } from "@/lib/commerce/integrated-checkout";
import { privateHeaders, readBody, readJson, sameOrigin, secureCookies } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure, requestId } from "@/lib/db/observability";
import { storefrontCookiePath } from "@/config/storefront-path";
import { cookieId, linkAcceptedOrder, measurementCookie, measurementEnabled } from "@/lib/measurement/server";
import { getShopper } from "@/lib/marketplace/auth";
import { manualReceiptLimit } from "@/lib/commerce/manual-payment-methods";
import { encodeCatalogImage } from "@/lib/staff/catalog-media";
import { OperationError } from "@/lib/staff/operations";

const requestBody = z.discriminatedUnion("action", [
  z.object({ action: z.literal("review"), checkout: z.unknown() }),
  z.object({ action: z.literal("submit"), checkout: z.unknown() }),
  z.object({ action: z.literal("recover"), attemptId: z.unknown() }),
]);

async function readCheckoutRequest(request: Request) {
  const type = request.headers.get("content-type") ?? "";
  if (!type.startsWith("multipart/form-data;")) return { payload: await readJson(request) };
  const body = await readBody(request, manualReceiptLimit + 36_000);
  if (!body) return { payload: null };
  try {
    const data = await new Response(new Uint8Array(body), { headers: { "Content-Type": type } }).formData();
    const payload = data.get("payload");
    const receipt = data.get("receipt");
    if (typeof payload !== "string" || payload.length > 32_768 || !(receipt instanceof File) ||
        receipt.size === 0 || receipt.size > manualReceiptLimit ||
        data.getAll("payload").length !== 1 || data.getAll("receipt").length !== 1) return { payload: null };
    return { payload: JSON.parse(payload) as unknown, receipt };
  } catch {
    return { payload: null };
  }
}

export async function POST(request: Request) {
  if (!sameOrigin(request)) {
    return NextResponse.json({ kind: "invalid", message: "Open checkout from this storefront." }, { status: 403, headers: privateHeaders });
  }

  const { payload, receipt } = await readCheckoutRequest(request);
  const parsed = requestBody.safeParse(payload);
  if (!parsed.success || (receipt && parsed.data.action !== "submit")) {
    return NextResponse.json({ kind: "invalid", message: "Checkout data is incomplete or too large." }, { status: 400, headers: privateHeaders });
  }

  const cookieStore = await cookies();
  const action = parsed.data;
  const reference = requestId();
  try {
    const market = await currentMarket();
    const recovered = integratedCheckout();
    if (market.stagingOnly || (!recovered && marketplaceMode() && !storefrontMarketAllowed("bd"))) {
      return NextResponse.json({ kind: "unavailable", message: "Checkout is unavailable for this storefront." }, { status: 404, headers: privateHeaders });
    }
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

    if (receipt && recovered) {
      return NextResponse.json({ kind: "unavailable", message: "Receipt upload is unavailable for this checkout." }, { status: 422, headers: privateHeaders });
    }
    let evidence: Uint8Array<ArrayBuffer> | undefined;
    if (receipt) {
      try {
        evidence = (await encodeCatalogImage(Buffer.from(await receipt.arrayBuffer()), receipt.type)).data;
      } catch (error) {
        if (!(error instanceof OperationError)) throw error;
        return NextResponse.json({ kind: "invalid", message: error.message }, { status: 422, headers: privateHeaders });
      }
    }
    const marketId = marketplaceMode() && !recovered ? "bd" : market.id;
    const result = action.action === "recover"
      ? await (recovered ? recoverRecovered : recoverCheckout)(action.attemptId, guestKey)
      : action.action === "review"
        ? await (recovered ? reviewRecovered : reviewCheckout)(action.checkout, marketId, guestKey)
        : recovered ? await submitRecovered(action.checkout, marketId, guestKey)
          : await submitCheckout(action.checkout, marketId, guestKey, (await getShopper())?.id, evidence);
    const status = result.kind === "conflict" || result.kind === "changed" ? 409
      : result.kind === "invalid" || result.kind === "unavailable" ? 422 : 200;
    const response = NextResponse.json(result, { status, headers: privateHeaders });
    if (token && result.kind === "review") {
      response.cookies.set(guestCookie, token, {
        httpOnly: true, sameSite: "lax", secure: secureCookies(), path: storefrontCookiePath, maxAge: guestMaxAge,
      });
    }
    if (result.kind === "placed" && !recovered && measurementEnabled() && request.headers.get("sec-gpc") !== "1") {
      const measurementToken = cookieStore.get(measurementCookie)?.value;
      const acceptedOrderId = result.orderId;
      const checkoutGuest = guestKey;
      // The transaction is committed. A reporting failure cannot change its response.
      after(async () => {
        try {
          const journeyId = cookieId(measurementToken);
          if (journeyId) await linkAcceptedOrder(acceptedOrderId, checkoutGuest, journeyId);
        } catch (error) {
          reportFailure("measurement.order-match", reference, error);
        }
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
