import Link from "next/link";
import { notFound } from "next/navigation";
import { marketStoreHref } from "@/config/regional-path";
import { currentMarket } from "@/lib/market-server";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { addressDistricts, savedAddresses } from "@/lib/marketplace/addresses";
import { accountText } from "@/lib/marketplace/account-language";
import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";
import { AddressBook } from "@/components/marketplace/address-book";
import { SignInGate } from "@/components/marketplace/session";

export const metadata = { title: "Saved addresses", robots: { index: false, follow: false } };

export default async function AddressesPage() {
  if (!marketplaceMode()) notFound();
  const market = await currentMarket();
  const [language, shopper] = await Promise.all([currentAccountLanguage(market.id), getShopper()]);
  const title = accountText(language, "Saved addresses", "সংরক্ষিত ঠিকানা");
  const accountHref = marketStoreHref("/account", hybridDemoMode() ? market.id : undefined);
  const country = market.id === "bd" ? accountText(language, "Bangladesh", "বাংলাদেশ") : market.name;
  const [addresses, districts] = shopper
    ? await Promise.all([savedAddresses(shopper.id, market.id), market.addressProfile === "district" ? addressDistricts() : []])
    : [[], []];

  return <div className="shell mp-page" lang={language}>
    <p><Link href={accountHref}>{accountText(language, "Back to My Account", "আমার অ্যাকাউন্টে ফিরুন")}</Link></p>
    <h1 className="mp-page-title">{title}</h1>
    <p>{country}</p>
    {shopper ? <AddressBook key={market.id} marketId={market.id} language={language} addresses={addresses} districts={districts} />
      : <SignInGate language={language}>{accountText(language, "Sign in to manage your addresses.", "ঠিকানা পরিচালনা করতে সাইন ইন করুন।")}</SignInGate>}
  </div>;
}
