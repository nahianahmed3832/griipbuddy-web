import { notFound } from "next/navigation";
import { AccountFrame } from "@/components/marketplace/account-frame";
import { AddressBook } from "@/components/marketplace/address-book";
import { SignInGate } from "@/components/marketplace/session";
import { currentMarket } from "@/lib/market-server";
import { accountText } from "@/lib/marketplace/account-language";
import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";
import { addressDistricts, savedAddresses } from "@/lib/marketplace/addresses";
import { getShopper } from "@/lib/marketplace/auth";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";

export const metadata = { title: "Saved addresses", robots: { index: false, follow: false } };

export default async function AddressesPage() {
  if (!marketplaceMode()) notFound();
  const market = await currentMarket();
  const [language, shopper] = await Promise.all([currentAccountLanguage(market.id), getShopper()]);
  const [addresses, districts] = shopper
    ? await Promise.all([savedAddresses(shopper.id, market.id), market.addressProfile === "district" ? addressDistricts() : []])
    : [[], []];

  return <AccountFrame market={market.id} language={language} hybrid={hybridDemoMode()} section="addresses">
    {shopper ? <AddressBook key={market.id} marketId={market.id} language={language} addresses={addresses} districts={districts} /> :
      <SignInGate language={language}>{accountText(language, "Sign in to manage your addresses.", "ঠিকানা পরিচালনা করতে সাইন ইন করুন।")}</SignInGate>}
  </AccountFrame>;
}
