import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure } from "@/lib/db/observability";
import { currentMarket } from "@/lib/market-server";
import { marketplaceMode } from "@/lib/release-config";

const input = z.strictObject({ email: z.string().trim().toLowerCase().max(254).pipe(z.email()), consent: z.literal(true) });

export async function POST(request: Request) {
  const response = (status: number, message: string) => Response.json({ message }, { status, headers: privateHeaders });
  if (!marketplaceMode()) return response(404, "Store update requests are unavailable.");
  if (!sameOrigin(request)) return response(403, "Submit the form from the storefront.");
  const parsed = input.safeParse(await readJson(request, 1024));
  if (!parsed.success) return response(422, "Enter a valid email and confirm that you want store updates.");
  const market = await currentMarket();
  if (market.status === "paused") return response(404, "Store update requests are unavailable in this market.");
  try {
    if (!await consumeQuota(`newsletter-client:${market.id}`, clientKey(request.headers), 50, 600) ||
        !await consumeQuota(`newsletter-address:${market.id}`, parsed.data.email, 5, 600)) {
      return response(429, "Too many attempts. Try again later.");
    }
    await getDb().newsletterRequest.createMany({ data: {
      email: parsed.data.email, marketId: market.id, locale: market.locale,
    }, skipDuplicates: true });
    return response(200, "Your request was saved. Email delivery is pending setup.");
  } catch (error) {
    reportFailure("newsletter.request", undefined, error);
    return response(503, "The request could not be saved. Try again later.");
  }
}
