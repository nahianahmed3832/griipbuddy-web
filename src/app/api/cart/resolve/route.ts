import { cookies } from "next/headers";
import { z } from "zod";
import { MAX_CART_LINES, MAX_QUANTITY, validCartOfferId, validVariantId, type CartItemReference } from "@/lib/cart/model";
import { resolveCartCatalog } from "@/lib/cart/resolve";
import { syncShopperCart } from "@/lib/cart/shared-cart";
import { cartSyncRequest } from "@/lib/cart/sync-contract";
import { personalizationAvailable, personalizationText } from "@/lib/catalog/personalization";
import { guestCookie, readGuestKey } from "@/lib/commerce/guest";
import { expireInventoryReservations } from "@/lib/commerce/inventory-reservations";
import { privateHeaders, readBody, sameOrigin } from "@/lib/db/http";
import type { DbReader } from "@/lib/db/client";
import { clientKey, consumeQuota, reportFailure } from "@/lib/db/observability";
import { currentMarket } from "@/lib/market-server";
import { getShopper } from "@/lib/marketplace/auth";

const offerIdInput = z.string().refine(validCartOfferId);
const variantIdInput = z.string().refine(validVariantId);
const lookupInput = z.union([
  z.strictObject({ variantIds: z.array(variantIdInput).max(MAX_CART_LINES) }),
  z.strictObject({ lines: z.array(z.strictObject({ variantId: variantIdInput, offerId: offerIdInput.optional() })).max(MAX_CART_LINES) }),
]);
const validateAddInput = z.strictObject({
  action: z.literal("validate-add"),
  marketId: z.string(),
  variantId: variantIdInput,
  offerId: offerIdInput,
  quantity: z.int().min(1).max(MAX_QUANTITY),
  personalization: z.string().trim().refine(value => Boolean(personalizationText(value))).optional(),
});
const fail = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
const changed = "This offer or quantity is unavailable. Review the item in your shopping market.";

async function resolvedStock(line: CartItemReference & { personalization?: string }, market: Awaited<ReturnType<typeof currentMarket>>,
  exact: boolean, db?: DbReader) {
  const [item] = await resolveCartCatalog([line], market, db);
  if (!item?.offer || exact && item.offer.id !== line.offerId || !personalizationAvailable(item.personalization, line.personalization)) return null;
  return item.offer.stock;
}

async function syncCart(request: Request, body: unknown) {
  const reject = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!sameOrigin(request)) return reject("Open the cart from this storefront.", 403);
  const input = cartSyncRequest.safeParse(body);
  if (!input.success) return reject("Invalid cart action.", 400);
  try {
    const shopper = await getShopper();
    if (!shopper) return reject("Sign in to sync your cart.", 401);
    if (shopper.id !== input.data.shopperId) return reject("The signed-in account changed. Refresh the page.", 403);
    const scope = input.data.mode === "read" ? "cart.sync.read" : "cart.sync.write";
    if (!await consumeQuota(scope, shopper.id, 300, 300)) return reject("Too many cart requests. Try again shortly.", 429);

    let checkStock: ((reader: DbReader) => Promise<number | null>) | undefined;
    const command = input.data.mode === "change" ? input.data.command : undefined;
    if (command && (command.type === "add" || command.type === "set" || command.type === "restore-saved") && command.offerId) {
      const market = await currentMarket();
      checkStock = reader => resolvedStock(command, market, command.type === "add", reader);
    }
    const purchase = input.data.mode === "change" && input.data.command.type === "complete-purchase";
    const guestKey = purchase ? readGuestKey((await cookies()).get(guestCookie)?.value) : null;
    const result = await syncShopperCart(shopper.id, input.data, guestKey, checkStock);
    return Response.json(result.body, { status: result.status, headers: privateHeaders });
  } catch (error) {
    reportFailure("cart.sync", undefined, error);
    return reject("Your cart couldn’t sync. Try again shortly.", 503);
  }
}

export async function POST(request: Request) {
  let body: unknown = null;
  try {
    const raw = await readBody(request, 65_536);
    if (raw) body = JSON.parse(raw.toString("utf8"));
  } catch { /* Invalid JSON is handled below. */ }
  const data = body && typeof body === "object" ? body : null;
  if (data && "action" in data && data.action === "cart-sync") return syncCart(request, body);

  try {
    const market = await currentMarket();
    if (data && "action" in data && data.action === "validate-add") {
      if (!sameOrigin(request)) return fail("Open the cart from this storefront.", 403);
      const parsed = validateAddInput.safeParse(body);
      if (!parsed.success) return fail("Invalid cart items.", 400);
      if (parsed.data.marketId !== market.id) return fail(changed, 409);
      if (!await consumeQuota("cart.validate-add", clientKey(request.headers), 120, 300)) {
        return fail("Too many cart requests. Try again shortly.", 429);
      }
      const stock = await resolvedStock(parsed.data, market, true);
      if (stock === null || stock < parsed.data.quantity) return fail(changed, 409);
      return Response.json({ marketId: market.id, stock }, { headers: privateHeaders });
    }
    const parsed = lookupInput.safeParse(body);
    if (!parsed.success) return fail("Invalid cart items.", 400);
    const refs = "lines" in parsed.data ? parsed.data.lines : parsed.data.variantIds.map(variantId => ({ variantId }));
    if (refs.length) await expireInventoryReservations(new Date(), 20, refs.map(({ variantId }) => variantId));
    const items = await resolveCartCatalog(refs, market);
    return Response.json({ marketId: market.id, items }, { headers: privateHeaders });
  } catch (error) {
    reportFailure("cart.resolve", undefined, error);
    return fail("Your cart couldn’t load. Try again shortly.", 503);
  }
}
