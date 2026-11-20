import type { MarketId } from "../../config/markets.ts";
import { privateHeaders, readJson, sameOrigin } from "../db/http.ts";
import { consumeQuota, reportFailure } from "../db/observability.ts";
import { isMarketSelectable, marketForStorefrontOrigin } from "../market-config.ts";
import { firstPartyStoreMode, marketplaceMode } from "../release-config.ts";
import { shopperActor } from "./auth.ts";
import { SellerHubError } from "./seller-hub.ts";

export async function sellerHubPost(request: Request, resource: "hub" | "team",
  run: (shopperId: string, marketId: MarketId, raw: unknown) => Promise<{ id: string }>) {
  const reject = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!marketplaceMode() || firstPartyStoreMode()) return reject("This seller workspace is unavailable.", 404);
  if (!sameOrigin(request)) return reject("Open this action from the storefront.", 403);
  try {
    const actor = await shopperActor(request.headers);
    if (!actor) return reject("Sign in to continue.", 401);
    const url = new URL(request.url);
    const values = url.searchParams.getAll("market");
    const routed = marketForStorefrontOrigin(url.origin);
    if (values.length !== 1 || !isMarketSelectable(values[0]) || routed && routed !== values[0]) return reject("Select one operating market.", 400);
    if (!await consumeQuota("marketplace.seller-" + resource, actor.id, 90, 300)) return reject("Try again shortly.", 429);
    const data = await run(actor.id, values[0], await readJson(request, 24_000));
    return Response.json({ data }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof SellerHubError) return reject(error.message, error.status);
    reportFailure("marketplace.seller-" + resource, undefined, error);
    return reject("The workspace could not confirm the change. Retry from the same form.", 503);
  }
}
