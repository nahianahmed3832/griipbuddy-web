"use server";

import { cookies } from "next/headers";
import { isStorefrontMarketId, marketCookie } from "@/config/markets";
import { demoAccount } from "@/config/store";
import { storefrontCookiePath } from "@/config/storefront-path";
import { secureCookies } from "@/lib/db/http";
import { fixtureMarketEnabled, productionMode } from "@/lib/release-config";

export async function changeMarket(value: unknown): Promise<boolean> {
  if (!isStorefrontMarketId(value, fixtureMarketEnabled())) return false;
  (await cookies()).set(marketCookie, value, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies(),
    path: storefrontCookiePath,
    maxAge: 60 * 60 * 24 * 365,
  });
  return true;
}

// This cookie changes the preview UI only. It grants no account or order access.
export async function setDemoAccount(signedIn: boolean, staySignedIn: boolean) {
  if (productionMode()) return;
  const cookieStore = await cookies();
  if (signedIn !== true) {
    cookieStore.delete(demoAccount.cookie);
    return;
  }

  cookieStore.set(demoAccount.cookie, "1", {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: staySignedIn === true ? 30 * 24 * 60 * 60 : undefined,
  });
}
