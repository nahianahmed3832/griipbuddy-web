"use client";

import type { MarketId } from "@/config/markets";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import { MarketplaceForm, useMarketplaceSubmission } from "./action-form";
import { accountRequest, marketplaceRequest } from "./session";

const endpoint = "/api/marketplace/account";
type Settings = { language: AccountLanguage; market: MarketId };

export function AccountLanguageForm({ language, market }: Settings) {
  if (market !== "bd") return null;
  const t = (en: string, bn: string) => accountText(language, en, bn);
  return <MarketplaceForm key={language} endpoint={endpoint} label={t("Save language", "ভাষা সংরক্ষণ করুন")} success={t("Language updated.", "ভাষা পরিবর্তন করা হয়েছে।")}
    errorMessage={t("Couldn’t save language. Try again.", "ভাষা সংরক্ষণ করা যায়নি। আবার চেষ্টা করুন।")}
    pendingLabel={t("Saving…", "সংরক্ষণ হচ্ছে…")}
    fields={<label>{t("Language", "ভাষা")}<select name="language" defaultValue={language}>
      <option value="en" lang="en">English</option><option value="bn" lang="bn">বাংলা</option>
    </select></label>} command={form => ({ action: "language", market, language: form.get("language") })} />;
}

export function ProfileForm({ name, language, market }: Settings & { name: string }) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  return <MarketplaceForm endpoint={endpoint} label={t("Save name", "নাম সংরক্ষণ করুন")} success={t("Name updated.", "নাম পরিবর্তন করা হয়েছে।")}
    errorMessage={t("Enter a name with 2 to 65 characters and try again.", "২ থেকে ৬৫ অক্ষরের নাম লিখে আবার চেষ্টা করুন।")}
    pendingLabel={t("Saving…", "সংরক্ষণ হচ্ছে…")}
    fields={<label>{t("Display name", "প্রদর্শিত নাম")}<input name="displayName" defaultValue={name} minLength={2} maxLength={65} required autoComplete="name" /></label>}
    command={form => ({ action: "profile", market, displayName: form.get("displayName") })} />;
}

export function PasswordForm({ language }: { language: AccountLanguage }) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const save = useMarketplaceSubmission(t("Check your current password and enter a new password of at least 10 characters.",
    "বর্তমান পাসওয়ার্ড যাচাই করুন এবং অন্তত ১০ অক্ষরের নতুন পাসওয়ার্ড লিখুন।"));
  return <form className="mp-form" onSubmit={async event => {
    event.preventDefault();
    const element = event.currentTarget;
    const data = new FormData(element);
    if (await save.submit(() => accountRequest("change-password", { currentPassword: data.get("current"), newPassword: data.get("next"),
      revokeOtherSessions: true }), t("Password changed. Other sessions have been signed out.", "পাসওয়ার্ড পরিবর্তন করা হয়েছে। অন্য সেশনগুলো থেকে সাইন আউট করা হয়েছে।"))) element.reset();
  }}>
    <label>{t("Current password", "বর্তমান পাসওয়ার্ড")}<input name="current" type="password" autoComplete="current-password" maxLength={128} required /></label>
    <label>{t("New password", "নতুন পাসওয়ার্ড")}<input name="next" type="password" autoComplete="new-password" minLength={10} maxLength={128} required /></label>
    <button className="button button--primary" disabled={save.pending}>{t("Change password", "পাসওয়ার্ড পরিবর্তন করুন")}</button>{save.feedback}
  </form>;
}

export function MarketingForm({ language, market, enabled }: Settings & { enabled: boolean }) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  return <MarketplaceForm endpoint={endpoint} label={t("Save preference", "পছন্দ সংরক্ষণ করুন")}
    success={t("Preference saved.", "পছন্দ সংরক্ষণ করা হয়েছে।")} pendingLabel={t("Saving…", "সংরক্ষণ হচ্ছে…")}
    errorMessage={t("Couldn’t save your preference. Try again.", "পছন্দ সংরক্ষণ করা যায়নি। আবার চেষ্টা করুন।")}
    fields={<label className="mp-remember"><input type="checkbox" name="marketing" defaultChecked={enabled} />
      {t("Send me offers and promotions", "অফার ও প্রচারের খবর পাঠান")}</label>}
    command={form => ({ action: "marketing", market, enabled: form.has("marketing") })} />;
}

export function DeletionRequest({ language, market }: Settings) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const request = useMarketplaceSubmission(t("Couldn’t send your request. Try again.", "অনুরোধ পাঠানো যায়নি। আবার চেষ্টা করুন।"));
  return <>
    <p>{t("Support will verify ownership before processing your request.", "অনুরোধ প্রক্রিয়ার আগে সহায়তা দল মালিকানা যাচাই করবে।")}</p>
    <button type="button" className="button button--outline" disabled={request.pending} onClick={() => void request.submit(
      () => marketplaceRequest({ action: "request-deletion", market }, endpoint),
      t("Request sent. Look for a reply in Messages.", "অনুরোধ পাঠানো হয়েছে। বার্তায় উত্তর দেখুন।"))}>
      {t("Request account deletion", "অ্যাকাউন্ট মুছে ফেলার অনুরোধ করুন")}
    </button>{request.feedback}
  </>;
}
