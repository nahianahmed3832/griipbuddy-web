"use client";

import { useState } from "react";
import type { MarketId } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import { ClaimOrder } from "./marketplace/purchase-actions";

type ResponseData = { path?: string; expiresAt?: string; message?: string };
type RecoveryAction = { action: "create"; orderId: string; marketId: MarketId } | { action: "redeem"; orderId: string; marketId: MarketId; token: string };

async function recoveryRequest(action: RecoveryAction, language: AccountLanguage) {
  const response = await fetch(storefrontPath("/api/checkout/order-recovery"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(action),
    cache: "no-store", referrerPolicy: "no-referrer",
  });
  const result = await response.json().catch(() => null) as ResponseData | null;
  if (!response.ok || !result || !result.path?.startsWith("/")) {
    throw new Error(result?.message ?? accountText(language, "Order recovery is temporarily unavailable. Try again shortly.",
      "এই মুহূর্তে অর্ডার খোলা যাচ্ছে না। একটু পর চেষ্টা করুন।"));
  }
  const url = new URL(result.path, window.location.origin);
  if (url.origin !== window.location.origin) throw new Error(accountText(language, "The order link could not be opened.", "অর্ডার লিংকটি খোলা যায়নি।"));
  return { url, expiresAt: result.expiresAt };
}

export function SavePrivateOrderLink({ orderId, marketId, language = "en" }: { orderId: string; marketId: MarketId; language?: AccountLanguage }) {
  const [link, setLink] = useState<{ url: string; expiresAt: string }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const t = (english: string, bangla: string) => accountText(language, english, bangla);

  async function createLink() {
    setError("");
    setNotice("");
    setPending(true);
    try {
      const { url, expiresAt } = await recoveryRequest({ action: "create", orderId, marketId }, language);
      if (!expiresAt || Number.isNaN(Date.parse(expiresAt))) throw new Error(t("The order link could not be created.", "অর্ডার লিংকটি তৈরি করা যায়নি।"));
      setLink({ url: url.href, expiresAt });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Try again shortly.", "একটু পর আবার চেষ্টা করুন।"));
    } finally {
      setPending(false);
    }
  }

  async function copyLink() {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
      setNotice(t("Private link copied.", "ব্যক্তিগত লিংকটি কপি হয়েছে।"));
    } catch {
      setNotice(t("Select and copy the private link above.", "ওপরের ব্যক্তিগত লিংকটি বেছে নিয়ে কপি করুন।"));
    }
  }

  return <section className="commerce-panel commerce-form">
    <h2>{t("Track this order on another device", "অন্য ডিভাইসে অর্ডার ট্র্যাক করুন")}</h2>
    <p>{t("Save a private link to view this order for seven days. Anyone with the link can see the items and order status, so keep it private.",
      "সাত দিন অর্ডারটি দেখতে একটি ব্যক্তিগত লিংক সংরক্ষণ করুন। লিংকটি দিয়ে পণ্য ও অর্ডারের অবস্থা দেখা যায়, তাই এটি গোপন রাখুন।")}</p>
    {link ? <>
      <label>{t("Private order link", "ব্যক্তিগত অর্ডার লিংক")}<input type="text" dir="ltr" value={link.url} readOnly onFocus={event => event.currentTarget.select()} /></label>
      <p>{t("Expires", "মেয়াদ শেষ হবে")} <time dateTime={link.expiresAt}>{new Date(link.expiresAt).toLocaleString(language === "bn" ? "bn-BD" : undefined, {
        dateStyle: "medium", timeStyle: "short",
      })}</time> {t("in your local time.", "আপনার স্থানীয় সময়ে।")}</p>
      <button className="button button--outline" type="button" onClick={copyLink}>{t("Copy private link", "ব্যক্তিগত লিংক কপি করুন")}</button>
    </> : <button className="button button--outline" type="button" onClick={createLink} disabled={pending}>
      {pending ? t("Creating link…", "লিংক তৈরি হচ্ছে…") : t("Create private link", "ব্যক্তিগত লিংক তৈরি করুন")}
    </button>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </section>;
}

export function OpenPrivateOrderLink({ orderId, marketId, language, receipt }: { orderId: string; marketId: MarketId; language: AccountLanguage; receipt: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const t = (english: string, bangla: string) => accountText(language, english, bangla);

  async function openLink() {
    const token = new URLSearchParams(window.location.hash.slice(1)).get("access");
    if (!token) {
      setError(t("Open the complete private link you saved. It includes an access code.", "সংরক্ষণ করা সম্পূর্ণ ব্যক্তিগত লিংকটি খুলুন। এতে একটি প্রবেশ কোড আছে।"));
      return;
    }
    setError("");
    setPending(true);
    try {
      const { url } = await recoveryRequest({ action: "redeem", orderId, marketId, token }, language);
      window.location.replace(url.href);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Try again shortly.", "একটু পর আবার চেষ্টা করুন।"));
      setPending(false);
    }
  }

  return <section className="commerce-panel commerce-form">
    <p>{t("Open the order to see the items, payment status, and delivery updates.", "পণ্য, পেমেন্ট ও ডেলিভারির খবর দেখতে অর্ডারটি খুলুন।")}</p>
    <button className="button button--primary" type="button" onClick={openLink} disabled={pending}>
      {pending ? t("Opening order…", "অর্ডার খোলা হচ্ছে…") : t("Open order", "অর্ডার খুলুন")}
    </button>
    {error && <p role="alert">{error}</p>}
    <ClaimOrder id={orderId} marketId={marketId} language={language} trackingReceipt={receipt} />
  </section>;
}
