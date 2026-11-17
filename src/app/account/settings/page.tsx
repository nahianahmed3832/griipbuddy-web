import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountLanguageForm, DeletionRequest, MarketingForm, PasswordForm, ProfileForm } from "@/components/marketplace/account";
import { AccountFrame } from "@/components/marketplace/account-frame";
import { SignInGate } from "@/components/marketplace/session";
import { marketStoreHref } from "@/config/regional-path";
import { store } from "@/config/store";
import { currentMarket } from "@/lib/market-server";
import { accountText } from "@/lib/marketplace/account-language";
import { currentAccountLanguage, marketAccountProfile } from "@/lib/marketplace/account-language-server";
import { getShopper } from "@/lib/marketplace/auth";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";

export const metadata = { title: "Profile and settings" };

export default async function AccountSettings() {
  if (!marketplaceMode()) notFound();
  const [market, language, shopper] = await Promise.all([currentMarket(), currentAccountLanguage(), getShopper()]);
  const hybrid = hybridDemoMode();
  const settings = { market: market.id, language };
  const href = (path: string) => marketStoreHref(path, hybrid ? market.id : undefined);
  const profile = shopper ? await marketAccountProfile(shopper.id, market.id) : null;
  const t = (en: string, bn: string) => accountText(language, en, bn);
  return <AccountFrame {...settings} hybrid={hybrid} section="settings">
    {market.id === "bd" && <section className="commerce-panel"><h2>{t("Site language", "সাইটের ভাষা")}</h2><AccountLanguageForm {...settings}/></section>}
    {shopper ? <>
      <section className="commerce-panel"><h2>{t("Profile", "প্রোফাইল")}</h2><ProfileForm {...settings} name={profile?.displayName ?? shopper.name}/></section>
      <section className="commerce-panel">
        <h2>{t("Sign-in and recovery", "সাইন ইন ও অ্যাকাউন্ট পুনরুদ্ধার")}</h2>
        <p>{shopper.email.endsWith("@phone.griipbuddy.invalid") && "phoneNumber" in shopper ? String(shopper.phoneNumber) : shopper.email}</p>
        <p>{t("For changes to your sign-in contact, ask support to verify your account.", "সাইন ইনের যোগাযোগের তথ্য বদলাতে সহায়তা দলের মাধ্যমে অ্যাকাউন্ট যাচাই করুন।")}
          {" "}<a href={`mailto:${store.supportEmail}`}>{store.supportEmail}</a></p>
        {!shopper.email.endsWith("@phone.griipbuddy.invalid") && <>
          <PasswordForm language={language}/>
          <Link href={href("/account/reset-password")}>{t("Forgot your password?", "পাসওয়ার্ড ভুলে গেছেন?")}</Link>
        </>}
      </section>
      <section className="commerce-panel">
        <h2>{t("Notifications", "বিজ্ঞপ্তি")}</h2>
        <p>{t("Order and support updates stay available in My Orders and Help & Returns.", "অর্ডার ও সহায়তার আপডেট আমার অর্ডার এবং সহায়তা ও ফেরত পাতায় দেখতে পাবেন।")}</p>
        <MarketingForm {...settings} enabled={profile?.marketingOptIn ?? false}/>
      </section>
      <section className="commerce-panel"><h2>{t("Account deletion", "অ্যাকাউন্ট মুছে ফেলা")}</h2>
        <DeletionRequest {...settings}/><p><Link href={href("/messages")}>{t("Open support messages", "সহায়তার বার্তা দেখুন")}</Link></p>
      </section>
    </> : <SignInGate language={language}>{t("Sign in to manage your profile and recovery settings.", "প্রোফাইল ও পুনরুদ্ধারের সেটিংস পরিচালনা করতে সাইন ইন করুন।")}</SignInGate>}
  </AccountFrame>;
}
