import { cookies } from "next/headers";
import { NextResponse, after } from "next/server";
import { z } from "zod";
import { storefrontCookiePath } from "@/config/storefront-path";
import { prepaidSubmissionInput, uuid } from "@/lib/commerce/checkout-types";
import { guestCookie, guestMaxAge, newGuestToken, readGuestKey } from "@/lib/commerce/guest";
import { prepaidError, reconcileExpiredPrepaid, recoverPrepaid, reviewPrepaid, startPrepaid } from "@/lib/commerce/prepaid-checkout";
import { prepaidConfig } from "@/lib/commerce/prepaid-config";
import { checkoutDestination } from "@/lib/commerce/market-commerce";
import { privateHeaders, readJson, sameOrigin, secureCookies } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure, requestId } from "@/lib/db/observability";
import { getShopper } from "@/lib/marketplace/auth";
import { measureCheckout } from "@/lib/measurement/checkout";
import { measurementCookie } from "@/lib/measurement/server";

const requestBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("review"), checkout: z.unknown() }),
  z.strictObject({ action: z.literal("start"), checkout: z.unknown(), direct: z.boolean() }),
  z.strictObject({ action: z.literal("recover"), attemptId: uuid, resume: z.boolean().optional() }),
]);

const json = (result: object, status = 200) => NextResponse.json(result, { headers: privateHeaders, status });

export async function POST(request: Request) {
  const config = prepaidConfig();
  if (!config) return json({ kind: "unavailable", message: "Online payment is unavailable for this checkout." }, 404);
  if (!sameOrigin(request)) return json({ kind: "invalid", message: "Open checkout from this storefront." }, 403);
  const marketId = checkoutDestination(request.headers, config.marketId, new URL(request.url).origin);
  if (marketId !== config.marketId) return json({ kind: "invalid", message: "Select a market with this checkout method." }, 422);
  const parsed = requestBody.safeParse(await readJson(request));
  if (!parsed.success) return json({ kind: "invalid", message: "Check your checkout details." }, 400);
  const { data } = parsed;
  const trace = requestId();

  try {
    const jar = await cookies();
    const existing = readGuestKey(jar.get(guestCookie)?.value);
    const namespace = `prepaid.${marketId}.${data.action}`;
    if (!await consumeQuota(`${namespace}.ip`, clientKey(request.headers), 40, 600) ||
        (existing && !await consumeQuota(`${namespace}.guest`, existing, 20, 600))) {
      return json({ kind: "error", message: "Too many checkout requests. Wait a moment and try again." }, 429);
    }
    const token = existing || data.action !== "review" ? undefined : newGuestToken();
    const guestKey = existing ?? readGuestKey(token);
    if (!guestKey) return json({ kind: "conflict", message: "This browser no longer has the original checkout session." }, 409);

    const shopperId = (await getShopper())?.id ?? null;
    const result = data.action === "review" ? await reviewPrepaid(data.checkout, guestKey, marketId, shopperId)
      : data.action === "start" ? await startPrepaid(data.checkout, guestKey, data.direct, shopperId, marketId)
      : await recoverPrepaid(data.attemptId, guestKey, data.resume, marketId, shopperId);
    const status = result.kind === "changed" || result.kind === "conflict" ? 409
      : result.kind === "invalid" || result.kind === "unavailable" ? 422 : 200;
    const response = json(result, status);
    if (token && result.kind === "review") response.cookies.set(guestCookie, token, {
      httpOnly: true, sameSite: "lax", secure: secureCookies(), path: storefrontCookiePath, maxAge: guestMaxAge,
    });
    if (result.kind === "review" || result.kind === "continue" || result.kind === "pending" || result.kind === "placed") {
      const attemptId = result.kind === "review" ? result.attemptId : data.action === "recover" ? data.attemptId
        : data.action === "start" ? prepaidSubmissionInput.safeParse(data.checkout).data?.attemptId : undefined;
      measureCheckout(request, jar.get(measurementCookie)?.value, {
        marketId, guestKey, reference: trace, attemptId, orderId: result.kind === "placed" ? result.orderId : undefined,
      });
    }
    if (data.action === "review") after(async () => {
      try {
        if (await consumeQuota("prepaid.reconcile", `sandbox.${marketId}`, 1, 60)) await reconcileExpiredPrepaid(marketId);
      } catch (error) { reportFailure("prepaid.reconcile", trace, error); }
    });
    return response;
  } catch (error) {
    const expected = prepaidError(error);
    if (expected) return json(expected, 422);
    reportFailure(`prepaid.${data.action}`, trace, error);
    return json({ kind: "error", message: "The store couldn’t confirm the payment status. Check it again before paying." }, 503);
  }
}
