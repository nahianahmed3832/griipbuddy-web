import Link from "next/link";
import type { ReactNode } from "react";
import type { MarketId } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { accountMarketName, accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import { getShopper } from "@/lib/marketplace/auth";
import { chooseStorefrontHref, identityHomeHref, isHandoffMarket, registeredStorefrontHref, shopperIdentityDirectory, storefrontHandoffUrl } from "@/lib/marketplace/identity-directory";
import { AccountLanguageForm } from "./account";
import "./customer-account.css";

export async function AccountFrame({ market, language, hybrid, section, children }: {
  market: MarketId; language: AccountLanguage; hybrid: boolean; section: "home" | "orders" | "addresses" | "help" | "settings"; children: ReactNode;
}) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const links = [
    ["home", "/account", t("Account home", "অ্যাকাউন্টের প্রথম পাতা")],
    ["orders", "/orders", t("My orders", "আমার অর্ডার")],
    ["addresses", "/account/addresses", t("Saved addresses", "সংরক্ষিত ঠিকানা")],
    ["help", "/account/help", t("Help & returns", "সহায়তা ও ফেরত")],
    ["settings", "/account/settings", t("Profile & settings", "প্রোফাইল ও সেটিংস")],
  ] as const;
  const home = links.find(([id]) => id === section)!;
  const other = market === "bd" ? "us" : "bd";
  const directory = hybrid ? shopperIdentityDirectory() : null;
  const selectedStore = directory && isHandoffMarket(other) && directory.current !== directory.stores[other]
    ? (await getShopper())
      ? storefrontHandoffUrl("start", directory.stores[other], { market: other, return: home[1] }).href
      : registeredStorefrontHref(home[1], other)
    : chooseStorefrontHref(other, home[1]);
  return <div className="shell mp-page customer-account" lang={language} aria-labelledby="account-title">
    <header className="customer-account__intro">
      <h1 className="mp-page-title" id="account-title">{section === "home" ? t("My account", "আমার অ্যাকাউন্ট") : home[2]}</h1>
      <p>{t("Shopping in", "কেনাকাটার দেশ")} <strong>{accountMarketName(language, market)}</strong></p>
      {hybrid && <a href={selectedStore}>
        {t("Switch to", "দেশ পরিবর্তন করুন:")} {accountMarketName(language, other)}
      </a>}
    </header>
    <nav aria-label={t("My account", "আমার অ্যাকাউন্ট")} className="customer-account__nav">
      {links.map(([id, path, label]) => <Link aria-current={id === section ? "page" : undefined}
        href={marketStoreHref(path, hybrid ? market : undefined)} key={id}>{label}</Link>)}
    </nav>
    {children}
    {hybrid && section === "home" && <p><a href={identityHomeHref()}>{t("All country storefronts", "সব দেশের স্টোরফ্রন্ট")}</a></p>}
  </div>;
}

export function GuestAccountLanguage({ market, language }: { market: MarketId; language: AccountLanguage }) {
  return market === "bd" ? <section className="commerce-panel"><AccountLanguageForm market={market} language={language} /></section> : null;
}
