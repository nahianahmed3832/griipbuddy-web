import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountLanguageForm, DeletionRequest, MarketingForm, PasswordForm, ProfileForm } from "@/components/marketplace/account";
import { AccountFrame } from "@/components/marketplace/account-frame";
import { SignInGate } from "@/components/marketplace/session";
import { marketStoreHref } from "@/config/regional-path";
import { store } from "@/config/store";
import { currentMarket } from "@/lib/market-server";
import { accountMarketName, accountText } from "@/lib/marketplace/account-language";
import { currentAccountLanguage, marketAccountProfile } from "@/lib/marketplace/account-language-server";
import { getShopper } from "@/lib/marketplace/auth";
import { orderCenterEnabled } from "@/lib/marketplace/order-center-config";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";

export const metadata = { title: "Account settings", robots: { index: false, follow: false } };

export default async function AccountSettings({ searchParams }: { searchParams: Promise<{ section?: string | string[] }> }) {
  if (!marketplaceMode()) notFound();
  const [market, language, shopper, { section }] = await Promise.all([
    currentMarket(), currentAccountLanguage(), getShopper(), searchParams,
  ]);
  const hybrid = hybridDemoMode();
  const settings = { market: market.id, language };
  const href = (path: string) => marketStoreHref(path, hybrid ? market.id : undefined);
  const profile = shopper ? await marketAccountProfile(shopper.id, market.id) : null;
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const sections = [
    { id: "profile", label: t("Profile", "প্রোফাইল") },
    { id: "security", label: t("Security", "নিরাপত্তা") },
    { id: "privacy", label: t("Privacy", "গোপনীয়তা") },
    { id: "preferences", label: t("Preferences", "পছন্দসমূহ") },
  ] as const;
  const active = sections.find(item => item.id === section)?.id ?? "profile";
  const usesPhone = shopper?.email.endsWith("@phone.griipbuddy.invalid");

  return <AccountFrame {...settings} hybrid={hybrid} section="settings">
    <nav className="customer-account__tabs" aria-label={t("Settings sections", "সেটিংসের বিভাগ")}>
      {sections.map(({ id, label }) => <Link key={id} aria-current={active === id ? "page" : undefined}
        href={href(id === "profile" ? "/account/settings" : `/account/settings?section=${id}`)}>{label}</Link>)}
    </nav>

    {active === "profile" && shopper && <section className="commerce-panel">
      <h2>{t("Your name", "আপনার নাম")}</h2>
      <p>{t("Manage the name shown in your GriipBuddy account.", "আপনার GriipBuddy অ্যাকাউন্টে দেখানো নাম পরিবর্তন করুন।")}</p>
      <ProfileForm {...settings} name={profile?.displayName ?? shopper.name} />
    </section>}

    {active === "security" && shopper && <>
      <section className="commerce-panel">
        <h2>{t("Sign-in contact", "সাইন ইনের যোগাযোগের তথ্য")}</h2>
        <p className="customer-account__detail">{usesPhone && "phoneNumber" in shopper ? String(shopper.phoneNumber ?? "") : shopper.email}</p>
        <p>{t("For changes to your sign-in contact, ask support to verify your account.", "সাইন ইনের যোগাযোগের তথ্য বদলাতে সহায়তা দলের মাধ্যমে অ্যাকাউন্ট যাচাই করুন।")}
          {" "}<a href={`mailto:${store.supportEmail}`}>{store.supportEmail}</a>
        </p>
      </section>
      {!usesPhone && <section className="commerce-panel">
        <h2>{t("Password", "পাসওয়ার্ড")}</h2>
        <PasswordForm language={language} />
        <p><Link href={href("/account/reset-password")}>{t("Forgot your password?", "পাসওয়ার্ড ভুলে গেছেন?")}</Link></p>
      </section>}
    </>}

    {active === "privacy" && <>
      <section className="commerce-panel">
        <h2>{t("Privacy policy", "গোপনীয়তা নীতি")}</h2>
        <p><Link href={href("/help/privacy")}>{t("Read the GriipBuddy privacy policy", "GriipBuddy-এর গোপনীয়তা নীতি পড়ুন")}</Link></p>
      </section>
      {shopper && <section className="commerce-panel">
        <h2>{t("Account deletion", "অ্যাকাউন্ট মুছে ফেলা")}</h2>
        <DeletionRequest {...settings} />
        <p><Link href={href("/messages")}>{t("Open support messages", "সহায়তার বার্তা দেখুন")}</Link></p>
      </section>}
    </>}

    {active === "preferences" && <>
      <section className="commerce-panel">
        <h2>{t("Storefront & language", "স্টোরফ্রন্ট ও ভাষা")}</h2>
        <p>{accountMarketName(language, market.id)}</p>
        <AccountLanguageForm {...settings} />
      </section>
      {shopper && <section className="commerce-panel">
        <h2>{t("Offers & promotions", "অফার ও প্রচার")}</h2>
        <MarketingForm {...settings} enabled={profile?.marketingOptIn ?? false} />
        {orderCenterEnabled(market.id) && <p><Link href={href("/account/notifications")}>
          {t("View order and refund notifications", "অর্ডার ও টাকা ফেরতের বিজ্ঞপ্তি দেখুন")}
        </Link></p>}
      </section>}
    </>}

    {!shopper && <SignInGate language={language}>{t("Sign in to manage the settings for your account.", "অ্যাকাউন্টের সেটিংস পরিচালনা করতে সাইন ইন করুন।")}</SignInGate>}
  </AccountFrame>;
}
