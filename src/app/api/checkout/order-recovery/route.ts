import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { z } from "zod";
import { marketIds } from "@/config/markets";
import { uuid } from "@/lib/commerce/checkout-types";
import { guestCookie, readGuestKey } from "@/lib/commerce/guest";
import {
  createGuestOrderLink, orderRecoveryEnabled, orderRecoveryToken, receiptAccessCookie, redeemGuestOrderLink,
} from "@/lib/commerce/order-recovery";
import { privateHeaders, readJson, sameOrigin, secureCookies } from "@/lib/db/http";
import { clientKey, consumeQuota, reportFailure, requestId } from "@/lib/db/observability";
import { currentMarket, storefrontMarketAllowed } from "@/lib/market-server";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";

const marketId = z.enum(marketIds).optional();
const requestBody = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create"), orderId: uuid, marketId }),
  z.strictObject({ action: z.literal("redeem"), orderId: uuid, marketId, token: orderRecoveryToken }),
]);

const headers = { ...privateHeaders, "X-Robots-Tag": "noindex, nofollow" };

function problem(message: string, status: number) {
  return NextResponse.json({ message }, { status, headers });
}

export async function POST(request: Request) {
  if (!orderRecoveryEnabled()) return problem("Order recovery is unavailable.", 404);
  const storefront = process.env.BETTER_AUTH_URL;
  if (!storefront || !URL.canParse(storefront) || !sameOrigin(request) || request.headers.get("origin") !== new URL(storefront).origin) {
    return problem("Open this link on the storefront.", 403);
  }
  const parsed = requestBody.safeParse(await readJson(request, 1024));
  if (!parsed.success) return problem("This private order link is invalid.", 400);
  const reference = requestId();
  let language: AccountLanguage = "en";
  const t = (english: string, bangla: string) => accountText(language, english, bangla);
  try {
    const data = parsed.data;
    const market = data.marketId ?? (await currentMarket()).id;
    if (!storefrontMarketAllowed(market)) return problem("This private order link is unavailable.", 404);
    language = await currentAccountLanguage(market);
    if (!await consumeQuota(`checkout.order-recovery.${data.action}`, clientKey(request.headers), 30, 600)) {
      return NextResponse.json({ message: t("Too many requests. Wait a few minutes and try again.", "অনেকবার চেষ্টা করা হয়েছে। কয়েক মিনিট পর আবার চেষ্টা করুন।") }, {
        status: 429, headers: { ...headers, "Retry-After": "600" },
      });
    }
    if (data.action === "create") {
      const guestKey = readGuestKey((await cookies()).get(guestCookie)?.value);
      const link = guestKey && await createGuestOrderLink(data.orderId, guestKey, market);
      return link ? NextResponse.json(link, { headers })
        : problem(t("Open this guest order in the browser you used to check out.", "যে ব্রাউজারে অর্ডার করেছিলেন, সেখানে অতিথি অর্ডারটি খুলুন।"), 404);
    }
    const access = await redeemGuestOrderLink(data.orderId, data.token, market);
    if (!access) return problem(t("This private order link is invalid or expired. Open the order in the original checkout browser to get a new link.",
      "ব্যক্তিগত অর্ডার লিংকটি ভুল বা মেয়াদ শেষ হয়েছে। নতুন লিংক নিতে যে ব্রাউজারে অর্ডার করেছিলেন, সেখানে অর্ডারটি খুলুন।"), 404);
    const response = NextResponse.json({ path: access.receipt }, { headers });
    response.cookies.set(receiptAccessCookie, access.cookie, {
      httpOnly: true, sameSite: "strict", secure: secureCookies(), path: access.cookiePath, maxAge: access.maxAge,
    });
    return response;
  } catch (error) {
    reportFailure("checkout.order-recovery", reference, error);
    return problem(t("Order recovery is temporarily unavailable. Try again shortly.", "এই মুহূর্তে অর্ডার খোলা যাচ্ছে না। একটু পর চেষ্টা করুন।"), 503);
  }
}
