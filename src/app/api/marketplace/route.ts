import { cookies } from "next/headers";
import { shopperActor } from "@/lib/marketplace/auth";
import { marketplaceCommand } from "@/lib/marketplace/commands";
import { applyMarketplaceCommand, MarketplaceError } from "@/lib/marketplace/write";
import { checkoutGuest, guestCookie } from "@/lib/commerce/guest";
import { getStaffFromHeaders } from "@/lib/staff/access";
import { firstPartyStoreMode, marketplaceMode } from "@/lib/release-config";
import { currentMarket } from "@/lib/market-server";
import { storeShop } from "@/lib/marketplace/constants";
import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";

export async function POST(request: Request) {
  const reject = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!marketplaceMode()) return new Response(null, { status: 404 });
  if (!sameOrigin(request)) return reject("Open this action from the storefront.", 403);
  const input = marketplaceCommand.safeParse(await readJson(request, 8192));
  if (!input.success) return reject("Check the entered details and try again.", 400);
  try {
    const command = input.data;
    if (firstPartyStoreMode() && (
      command.action === "create-shop" || command.action === "edit-shop" || command.action === "draft-listing" ||
      command.action === "request-market" || command.action === "follow" || command.action === "open-message" && command.shop !== storeShop.id
    )) return reject("This action is unavailable.", 404);
    const shopper = await shopperActor(request.headers);
    const mayUseStaff = command.action.startsWith("staff-") || command.action === "reply" || command.action === "close-thread";
    const staff = mayUseStaff ? await getStaffFromHeaders(request.headers) : null;
    const owner = staff?.kind === "core-admin" ? staff : undefined;
    const subject = owner ? `staff:${owner.id}` : shopper ? `shopper:${shopper.id}` : null;
    if (!subject) return reject("Sign in to continue.", 401);
    if (!await consumeQuota("marketplace.write", subject, 90, 300)) return reject("Too many actions. Try again shortly.", 429);
    const guest = command.action === "claim-order" ? checkoutGuest((await cookies()).get(guestCookie)?.value) : undefined;
    const market = await currentMarket();
    const data = await applyMarketplaceCommand(command, {
      shopperId: shopper?.id, guestKey: guest?.id, marketId: market.id, staffOwner: Boolean(owner), staffActorId: owner?.id,
    });
    return Response.json({ data }, { headers: privateHeaders });
  } catch (error) {
    if (error instanceof MarketplaceError) return reject(error.message, error.status);
    if (typeof error === "object" && error && "code" in error) {
      if (error.code === "P2002") return reject("That name, shop, or SKU is already in use.", 409);
      if (error.code === "P2025") return reject("We couldn't find this record.", 404);
    }
    reportFailure("marketplace.write", undefined, error);
    return reject("We couldn't save this change. Try again.", 503);
  }
}
