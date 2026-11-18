import { NextResponse } from "next/server";
import { z } from "zod";
import { marketIds, marketSupportsLanguage } from "@/config/markets";
import { storefrontCookiePath } from "@/config/storefront-path";
import { getDb } from "@/lib/db/client";
import { privateHeaders, readJson, sameOrigin, secureCookies } from "@/lib/db/http";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";
import { currentMarket, storefrontMarketAllowed } from "@/lib/market-server";
import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";
import { getShopper } from "@/lib/marketplace/auth";
import { accountLanguageCookie } from "@/lib/marketplace/account-language";
import { storeShop } from "@/lib/marketplace/constants";
import { orderCenterEnabled } from "@/lib/marketplace/order-center-config";
import { markShopOrderNotificationsRead, orderNoticeKey, orderNoticePageSize } from "@/lib/marketplace/order-notification-inbox";

const market = z.enum(marketIds);
const schema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("language"), market, language: z.enum(["en", "bn"]) }),
  z.strictObject({ action: z.literal("profile"), market, displayName: z.string().trim().min(2).max(65).regex(/^[^\p{Cc}]+$/u) }),
  z.strictObject({ action: z.literal("marketing"), market, enabled: z.boolean() }),
  z.strictObject({ action: z.literal("request-deletion"), market }),
  z.strictObject({ action: z.literal("read-order-notifications"), market,
    keys: z.array(orderNoticeKey).min(1).max(orderNoticePageSize) }),
]);

const reply = (data: object, status = 200) => NextResponse.json(data, { status, headers: privateHeaders });

export async function POST(request: Request) {
  if (!marketplaceMode()) return reply({}, 404);
  if (!sameOrigin(request) || request.headers.get("x-forwarded-host") === "demoseller.griipbuddy.com") return reply({}, 403);
  const parsed = schema.safeParse(await readJson(request, 1500));
  if (!parsed.success) return reply({ code: "invalid" }, 422);
  const command = parsed.data;
  if (!storefrontMarketAllowed(command.market)) return reply({}, 404);
  const marketId = hybridDemoMode() ? command.market : (await currentMarket()).id;
  if (command.action === "language" && !marketSupportsLanguage(marketId, command.language)) {
    return reply({ code: "invalid" }, 422);
  }
  if (command.action === "read-order-notifications") {
    const selected = (await currentMarket()).id;
    if (selected !== command.market || !orderCenterEnabled(selected)) return reply({}, 404);
    const shopper = await getShopper();
    if (!shopper) return reply({ code: "sign-in" }, 401);
    await markShopOrderNotificationsRead(shopper.id, selected, command.keys);
    return reply({ ok: true });
  }
  const shopper = await getShopper();
  if (!shopper && command.action !== "language") return reply({ code: "sign-in" }, 401);
  if (shopper) {
    const shopperId = shopper.id;
    const initialLanguage = await currentAccountLanguage(marketId);
    await getDb().$transaction(async tx => {
      await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${shopperId}), 63)`;
      if (command.action === "request-deletion") {
        const subject = "Account deletion request";
        const existing = await tx.shopperRequest.findFirst({ where: { shopperId, shopId: storeShop.id, subject, closed: false }, select: { id: true } });
        if (existing) return;
        await tx.shopperRequest.create({ data: { shopperId, shopId: storeShop.id, subject, messages: { create: {
          text: `Account deletion requested from the ${marketId.toUpperCase()} storefront. Verify account ownership before processing.`,
        } } } });
      } else {
        const change = command.action === "profile" ? { displayName: command.displayName } : command.action === "language"
          ? { language: command.language } : { marketingOptIn: command.enabled };
        await tx.shopperMarketProfile.upsert({ where: { shopperId_marketId: { shopperId, marketId } },
          create: { shopperId, marketId, language: initialLanguage, ...change }, update: change });
      }
      await tx.shopperAccountEvent.create({ data: { shopperId, marketId, action: command.action } });
    });
  }
  const response = reply({ ok: true });
  if (marketId === "bd" && command.action === "language") {
    response.cookies.set(accountLanguageCookie, command.language, { path: storefrontCookiePath, secure: secureCookies(),
      httpOnly: true, sameSite: "lax", maxAge: 365 * 24 * 60 * 60 });
  }
  return response;
}
