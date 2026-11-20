"use server";

import { cookies } from "next/headers";
import { languageCookie, marketCookie } from "@/config/markets";
import { demoAccount } from "@/config/store";
import { productionMode } from "@/lib/release-config";
import { isMarketSelectable } from "@/lib/market-config";
import { preferenceCookie, shoppingPreferenceDestination } from "@/lib/catalog/preference-destination";

export async function changeMarket(value: unknown): Promise<boolean> {
  if (!isMarketSelectable(value)) return false;
  (await cookies()).set(marketCookie, value, preferenceCookie());
  return true;
}

export async function changeShoppingPreferences(input: unknown): Promise<string | null> {
  const preferences = await shoppingPreferenceDestination(input);
  if (!preferences) return null;
  const cookieStore = await cookies();
  const options = preferenceCookie();
  cookieStore.set(marketCookie, preferences.marketId, options);
  cookieStore.set(languageCookie, preferences.locale, options);
  return preferences.href;
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
