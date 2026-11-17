import { cookies } from "next/headers";
import { NextResponse, after } from "next/server";
import { z } from "zod";
import { uuid } from "@/lib/commerce/checkout-types";
import { guestCookie, readGuestKey } from "@/lib/commerce/guest";
import { prepaidError, reconcileExpiredPrepaid, recoverPrepaid } from "@/lib/commerce/prepaid-checkout";
import { prepaidConfig } from "@/lib/commerce/prepaid-config";
import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure, requestId } from "@/lib/db/observability";

const recoveryBody = z.strictObject({ action: z.literal("recover"), attemptId: uuid, resume: z.boolean().optional() });
const json = (result: object, status = 200) => NextResponse.json(result, { headers: privateHeaders, status });

export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ kind: "invalid", message: "Open checkout from this storefront." }, 403);
  const parsed = recoveryBody.safeParse(await readJson(request));
  if (!parsed.success || !prepaidConfig()) {
    return json({ kind: "unavailable", message: "This payment provider is no longer available for new checkouts." }, 422);
  }
  const trace = requestId();
  try {
    const jar = await cookies();
    const guestKey = readGuestKey(jar.get(guestCookie)?.value);
    if (!guestKey) return json({ kind: "conflict", message: "This browser no longer has the original checkout session." }, 409);
    if (!await consumeQuota("prepaid.recover.ip", clientKey(request.headers), 40, 600) ||
        !await consumeQuota("prepaid.recover.guest", guestKey, 20, 600)) {
      return json({ kind: "error", message: "Too many checkout requests. Wait a moment and try again." }, 429);
    }
    const result = await recoverPrepaid(parsed.data.attemptId, guestKey, parsed.data.resume);
    const status = result.kind === "changed" || result.kind === "conflict" ? 409
      : result.kind === "invalid" || result.kind === "unavailable" ? 422 : 200;
    after(async () => {
      try {
        if (await consumeQuota("prepaid.reconcile", "sandbox", 1, 60)) await reconcileExpiredPrepaid();
      } catch (error) { reportFailure("prepaid.reconcile", trace, error); }
    });
    return json(result, status);
  } catch (error) {
    const expected = prepaidError(error);
    if (expected) return json(expected, 422);
    reportFailure("prepaid.recover", trace, error);
    return json({ kind: "error", message: "The store couldn’t confirm the payment status. Check it again before paying." }, 503);
  }
}
