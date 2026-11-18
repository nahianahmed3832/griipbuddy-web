import { ArrowUpRight, Bell, CircleHelp, House, MapPin, Package, Settings2 } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import type { MarketId } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { accountMarketName, accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import { getShopper } from "@/lib/marketplace/auth";
import { chooseStorefrontHref, identityHomeHref, isHandoffMarket, registeredStorefrontHref, shopperIdentityDirectory, storefrontHandoffUrl } from "@/lib/marketplace/identity-directory";
import { orderCenterEnabled } from "@/lib/marketplace/order-center-config";
import { AccountLanguageForm } from "./account";
import "./customer-account.css";

type AccountSection = "home" | "orders" | "addresses" | "help" | "settings" | "notifications";

export async function AccountFrame({ market, language, hybrid, section, children }: {
  market: MarketId; language: AccountLanguage; hybrid: boolean; section: AccountSection; children: ReactNode;
}) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const links = {
    home: { path: "/account", label: t("Overview", "এক নজরে"), title: t("My account", "আমার অ্যাকাউন্ট"), icon: House },
    orders: { path: "/orders", label: t("My Orders", "আমার অর্ডার"), icon: Package },
    notifications: { path: "/account/notifications", label: t("Notifications", "বিজ্ঞপ্তি"), icon: Bell },
    help: { path: "/account/help", label: t("Help & returns", "সহায়তা ও ফেরত"), icon: CircleHelp },
    settings: { path: "/account/settings", label: t("Account settings", "অ্যাকাউন্ট সেটিংস"), icon: Settings2 },
    addresses: { path: "/account/addresses", label: t("Saved addresses", "সংরক্ষিত ঠিকানা"), icon: MapPin },
  };
  const shopping: AccountSection[] = ["home", "orders"];
  if (orderCenterEnabled(market)) shopping.push("notifications");
  shopping.push("help");
  const groups: { label: string; ids: AccountSection[] }[] = [
    { label: t("Shopping", "কেনাকাটা"), ids: shopping },
    { label: t("Manage account", "অ্যাকাউন্ট পরিচালনা"), ids: ["settings", "addresses"] },
  ];
  const active = links[section];
  const other = market === "bd" ? "us" : "bd";
  const directory = hybrid ? shopperIdentityDirectory() : null;
  const returnPath = section === "notifications" && !orderCenterEnabled(other) ? "/account" : active.path;
  const selectedStore = directory && isHandoffMarket(other) && directory.current !== directory.stores[other]
    ? (await getShopper())
      ? storefrontHandoffUrl("start", directory.stores[other], { market: other, return: returnPath }).href
      : registeredStorefrontHref(returnPath, other)
    : chooseStorefrontHref(other, returnPath);

  return <div className="shell mp-page customer-account customer-account--workspace" lang={language} aria-labelledby="account-title">
    <header className="customer-account__banner">
      <h1 id="account-title">{section === "home" ? links.home.title : active.label}</h1>
      <div className="customer-account__market">
        <div><MapPin size={17} aria-hidden="true" /><strong>{accountMarketName(language, market)}</strong></div>
        {hybrid && <a href={selectedStore}>
          {t("Switch to", "দেশ পরিবর্তন করুন:")} {accountMarketName(language, other)}
          <ArrowUpRight size={14} aria-hidden="true" />
        </a>}
      </div>
    </header>
    <div className="customer-account__layout">
      <nav aria-label={t("My account", "আমার অ্যাকাউন্ট")} className="customer-account__sidebar">
        {groups.map(group => <div key={group.label} className="customer-account__group">
          <p>{group.label}</p>
          <ul>{group.ids.map(id => {
            const { path, label, icon: Icon } = links[id];
            return <li key={id}><Link aria-current={id === section ? "page" : undefined}
              href={marketStoreHref(path, hybrid ? market : undefined)}>
              <Icon size={18} strokeWidth={1.8} aria-hidden="true" /><span>{label}</span>
            </Link></li>;
          })}</ul>
        </div>)}
      </nav>
      <div className="customer-account__content">
        {children}
        {hybrid && section === "home" && <p className="customer-account__other-stores">
          <a href={identityHomeHref()}>{t("All country storefronts", "সব দেশের স্টোরফ্রন্ট")} <ArrowUpRight size={15} aria-hidden="true" /></a>
        </p>}
      </div>
    </div>
  </div>;
}

export function GuestAccountLanguage({ market, language }: { market: MarketId; language: AccountLanguage }) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  return market === "bd" ? <section className="commerce-panel">
    <h2>{t("Site language", "সাইটের ভাষা")}</h2>
    <AccountLanguageForm market={market} language={language} />
  </section> : null;
}
