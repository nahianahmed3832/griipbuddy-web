"use client";

import type { MarketId } from "@/config/markets";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import { MarketplaceForm, useMarketplaceSubmission } from "./action-form";
import { MessageShop } from "./messages";
import { marketplaceRequest, useMarketplace } from "./session";

export function ClaimOrder({ id, marketId, language = "en", trackingReceipt }: {
  id: string; marketId: MarketId; language?: AccountLanguage; trackingReceipt?: string;
}) {
  const account = useMarketplace();
  const action = useMarketplaceSubmission();
  const t = (english: string, bangla: string) => accountText(language, english, bangla);
  if (!account) return null;
  async function claim() {
    if (!account?.shopper) {
      account?.openAuth();
      return;
    }
    const saved = await action.submit(() => {
      const trackingToken = trackingReceipt ? new URLSearchParams(window.location.hash.slice(1)).get("access") : undefined;
      if (trackingReceipt && !trackingToken) throw new Error(t("Open the complete private tracking link.", "সম্পূর্ণ ব্যক্তিগত ট্র্যাকিং লিংকটি খুলুন।"));
      return marketplaceRequest({ action: "claim-order", order: id, marketId, ...(trackingToken && { trackingToken }) });
    }, t("Order saved to your purchases.", "অর্ডারটি আমার অর্ডারে যোগ হয়েছে।"));
    if (saved && trackingReceipt) window.location.replace(trackingReceipt);
  }
  return <div className="mp-form">
    <p>{t("Use the verified email or phone number from checkout to save this order.", "অর্ডারটি সংরক্ষণ করতে চেকআউটে ব্যবহৃত যাচাই করা ইমেইল বা মোবাইল নম্বর ব্যবহার করুন।")}</p>
    <button className="button button--outline" type="button" disabled={action.pending} onClick={() => void claim()}>
      {action.pending ? t("Saving…", "সংরক্ষণ হচ্ছে…") : account.shopper
        ? t("Save order to your account", "অ্যাকাউন্টে অর্ডার সংরক্ষণ করুন") : t("Sign in to save this order", "অর্ডারটি সংরক্ষণ করতে সাইন ইন করুন")}
    </button>
    {action.feedback}
  </div>;
}

export function OrderHelp({ id, shops }: { id: string; shops: { id: string; name: string }[] }) {
  return <div className="mp-panel-links">{shops.map(shop => <MessageShop key={shop.id} shop={shop.id} shopName={shop.name} order={id}/>)}</div>;
}

export function ReviewPurchase({ id, item, saved, marketId, language = "en" }: {
  id: string; item: { productId: string; name: string }; saved?: { text: string; stars: number; visible: boolean };
  marketId?: MarketId; language?: AccountLanguage;
}) {
  const t = (english: string, bangla: string) => accountText(language, english, bangla);
  return <details className="mp-section">
    <summary>{saved ? t("Edit your review of", "রিভিউ সম্পাদনা করুন") : t("Review", "রিভিউ দিন")} · {item.name}</summary>
    {saved && !saved.visible && <p>{t("Your review is waiting for moderation.", "আপনার রিভিউ যাচাইয়ের অপেক্ষায় আছে।")}</p>}
    <MarketplaceForm label={t("Submit review", "রিভিউ পাঠান")} success={t("Review submitted for moderation.", "রিভিউ যাচাইয়ের জন্য পাঠানো হয়েছে।")} fields={<>
      <label>{t("Rating", "রেটিং")}<select name="stars" defaultValue={saved?.stars ?? 5}>{[5, 4, 3, 2, 1].map(stars => <option key={stars} value={stars}>{stars} {t(stars === 1 ? "star" : "stars", "তারকা")}</option>)}</select></label>
      <label>{t("Your review", "আপনার রিভিউ")}<textarea name="text" defaultValue={saved?.text ?? ""} rows={4} minLength={5} maxLength={1200} required/></label>
    </>} command={form => ({ action: "review", order: id, marketId, product: item.productId, stars: Number(form.get("stars")), text: form.get("text") })}/>
  </details>;
}
