import { cookies } from "next/headers";
import { z } from "zod";
import { cartOfferKey, MAX_CART_LINES, MAX_QUANTITY, validCartOfferId, validVariantId, type CartItemReference } from "@/lib/cart/model";
import { resolveCartCatalog } from "@/lib/cart/resolve";
import { syncShopperCart } from "@/lib/cart/shared-cart";
import { cartSyncRequest } from "@/lib/cart/sync-contract";
import { personalizationAvailable, personalizationText } from "@/lib/catalog/personalization";
import { checkoutDestination } from "@/lib/commerce/market-commerce";
import { guestCookie, readGuestKey } from "@/lib/commerce/guest";
import { expireInventoryReservations } from "@/lib/commerce/inventory-reservations";
import { privateHeaders, readBody, sameOrigin } from "@/lib/db/http";
import { getDb, type DbReader } from "@/lib/db/client";
import { clientKey, consumeQuota, reportFailure } from "@/lib/db/observability";
import { currentMarket } from "@/lib/market-server";
import { shopperActor } from "@/lib/marketplace/auth";
import { marketConfiguration, marketIdInput } from "@/lib/market-config";

const offerIdInput = z.string().refine(validCartOfferId);
const variantIdInput = z.string().refine(validVariantId);
const lookupInput = z.union([
  z.strictObject({ variantIds: z.array(variantIdInput).max(MAX_CART_LINES) }),
  z.strictObject({ lines: z.array(z.strictObject({ variantId: variantIdInput, offerId: offerIdInput.optional() })).max(MAX_CART_LINES) }),
]);
const validateAddInput = z.strictObject({
  action: z.literal("validate-add"),
  marketId: marketIdInput,
  variantId: variantIdInput,
  offerId: offerIdInput.optional(),
  quantity: z.int().min(1).max(MAX_QUANTITY),
  personalization: z.string().trim().refine(value => Boolean(personalizationText(value))).optional(),
});
const legacyScopeInput = z.strictObject({ action: z.literal("legacy-market-cart"), marketId: marketIdInput,
  lines: z.array(z.strictObject({ variantId: variantIdInput, offerId: offerIdInput })).max(MAX_CART_LINES * 2),
});
const fail = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
const changed = "This offer or quantity is unavailable. Review the item in your shopping market.";

async function resolvedStock(line: CartItemReference & { personalization?: string }, market: Awaited<ReturnType<typeof currentMarket>>,
  exact: boolean, db?: DbReader) {
  const [item] = await resolveCartCatalog([line], market, db);
  if (!item?.offer || exact && item.offer.id !== line.offerId || !personalizationAvailable(item.personalization, line.personalization)) return null;
  return item.offer.stock;
}

async function requestMarket(request: Request) {
  const selected = await currentMarket();
  const id = checkoutDestination(request.headers, selected.id, new URL(request.url).origin);
  return id ? id === selected.id ? selected : marketConfiguration(id) : null;
}

async function boundOffers(lines: readonly CartItemReference[], market: Awaited<ReturnType<typeof currentMarket>>, db: DbReader) {
  const refs = lines.flatMap(line => line.offerId ? [line.offerId] : []);
  if (!refs.length) return new Set<string>();
  const identities = await db.marketOfferIdentity.findMany({ where: { id: { in: refs }, marketId: market.id },
    select: { id: true, variantId: true } });
  return new Set(identities.map(line => cartOfferKey({ variantId: line.variantId, offerId: line.id })));
}

async function syncCart(request: Request, body: unknown) {
  const reject = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!sameOrigin(request)) return reject("Open the cart from this storefront.", 403);
  const input = cartSyncRequest.safeParse(body);
  if (!input.success) return reject("Invalid cart action.", 400);
  try {
    const shopper = await shopperActor(request.headers);
    if (!shopper) return reject("Sign in to sync your cart.", 401);
    if (shopper.id !== input.data.shopperId) return reject("The signed-in account changed. Refresh the page.", 403);
    const market = await requestMarket(request);
    if (!market || input.data.marketId !== market.id) return reject("Open the cart for this shopping market.", 400);
    const scope = input.data.mode === "read" ? "cart.sync.read" : "cart.sync.write";
    if (!await consumeQuota(scope, shopper.id, 300, 300)) return reject("Too many cart requests. Try again shortly.", 429);

    const action = input.data;
    const command = action.mode === "change" ? action.command : undefined;
    const stock = command && (command.type === "add" || command.type === "restore-saved" ||
        command.type === "set" && command.quantity > command.expectedQuantity)
      ? (reader: DbReader) => resolvedStock(command, market, command.type === "add", reader) : undefined;
    const merge = action.mode === "merge" ? async (reader: DbReader) => {
      const lines = [...action.items, ...action.saved];
      const exact = await boundOffers(lines, market, reader);
      if (lines.some(line => line.offerId && !exact.has(cartOfferKey(line)))) return false;
      const legacy = lines.filter(line => !line.offerId);
      const resolved = await resolveCartCatalog(legacy, market, reader);
      const byRef = new Map(resolved.map(item => [item.requestedVariantId ?? item.variantId, item]));
      return legacy.every(line => byRef.get(line.variantId)?.offer?.marketId === market.id);
    } : undefined;
    const guestKey = command?.type === "complete-purchase" ? readGuestKey((await cookies()).get(guestCookie)?.value) : null;
    const result = await syncShopperCart(shopper.id, action, { stock, merge, guestKey });
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
    const market = await requestMarket(request);
    if (!market) return fail("Open the cart for this shopping market.", 400);
    if (data && "action" in data && data.action === "legacy-market-cart") {
      if (!sameOrigin(request)) return fail("Open the cart from this storefront.", 403);
      const parsed = legacyScopeInput.safeParse(body);
      if (!parsed.success || parsed.data.marketId !== market.id) return fail("Invalid cart items.", 400);
      if (!await consumeQuota("cart.legacy-market", clientKey(request.headers), 40, 300)) {
        return fail("Too many cart requests. Try again shortly.", 429);
      }
      const exact = await boundOffers(parsed.data.lines, market, getDb());
      return Response.json({ marketId: market.id, matched: parsed.data.lines.filter(line => exact.has(cartOfferKey(line))) },
        { headers: privateHeaders });
    }
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
