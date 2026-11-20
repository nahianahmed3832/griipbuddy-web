import type { NextRequest } from "next/server";
import { z } from "zod";
import { privateHeaders } from "../db/http.ts";
import { clientKey, consumeQuota, reportFailure } from "../db/observability.ts";
import { shopperAuth } from "../marketplace/auth.ts";
import { marketplaceMode } from "../release-config.ts";
import { guestCookie, readGuestKey } from "./guest.ts";
import { readOrderTracking, type OrderTrackingViewer } from "./order-tracking.ts";

const orderId = z.uuid();
const headers = { ...privateHeaders, "X-Robots-Tag": "noindex, nofollow", Vary: "Cookie" };
const unavailable = () => Response.json({ error: { code: "tracking_unavailable", message: "Tracking is unavailable for this order." } }, {
  status: 404, headers,
});
const limited = () => Response.json({ error: { code: "rate_limited", message: "Wait a minute before checking tracking again." } }, {
  status: 429, headers: { ...headers, "Retry-After": "60" },
});

async function viewer(request: NextRequest, access: "account" | "guest"): Promise<OrderTrackingViewer | null> {
  if (access === "guest") {
    const guestKey = readGuestKey(request.cookies.get(guestCookie)?.value);
    return guestKey ? { guestKey } : null;
  }
  if (!marketplaceMode()) return null;
  const session = await shopperAuth().api.getSession({ headers: request.headers });
  return session?.user ? { shopperId: session.user.id } : null;
}

export async function handleOrderTracking(request: NextRequest, id: string, access: "account" | "guest") {
  if (request.headers.get("sec-fetch-site") === "cross-site") return unavailable();
  const { searchParams } = request.nextUrl;
  const after = searchParams.get("after");
  if (!orderId.safeParse(id).success || searchParams.size > (after === null ? 0 : 1) ||
      (after !== null && !orderId.safeParse(after).success)) return unavailable();
  try {
    const client = clientKey(request.headers);
    if (client !== "unattributed" && !await consumeQuota("order-tracking.ip", client, 120, 60)) return limited();
    const owner = await viewer(request, access);
    if (!owner) return unavailable();
    const subject = "shopperId" in owner ? `account:${owner.shopperId}` : `guest:${owner.guestKey}`;
    if (!await consumeQuota("order-tracking.viewer", subject, 30, 60)) return limited();
    const data = await readOrderTracking(id, owner, after);
    return data ? Response.json(data, { headers }) : unavailable();
  } catch (error) {
    reportFailure("order-tracking.read", undefined, error);
    return Response.json({ error: { code: "tracking_temporarily_unavailable", message: "Tracking is temporarily unavailable." } }, {
      status: 503, headers,
    });
  }
}
