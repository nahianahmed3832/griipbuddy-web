"use client";

import { useState, type FormEvent } from "react";
import type { MarketId } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import type { OrderCaseKind, OrderCaseStatus } from "@/generated/prisma/enums";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import { caseKindLabel, caseReasonLabel } from "@/lib/marketplace/case-language";
import { activeCaseStatuses, caseReasons, mayWithdrawCase } from "@/lib/marketplace/case-policy";
import { MarketplaceForm, useMarketplaceSubmission } from "./action-form";

const caseEndpoint = (market: MarketId, language: AccountLanguage = "en") =>
  "/api/marketplace/cases?" + new URLSearchParams({ market, lang: language });

async function submitCase(command: object, photo: File | null, endpoint: string, language: AccountLanguage): Promise<{ id: string }> {
  let body: BodyInit = JSON.stringify(command);
  let headers: HeadersInit | undefined = { "Content-Type": "application/json" };
  if (photo?.size) {
    const data = new FormData();
    data.append("payload", JSON.stringify(command));
    data.append("photo", photo);
    body = data;
    headers = undefined;
  }
  const fallback = accountText(language, "We couldn't submit the request. Try again.", "অনুরোধটি জমা দেওয়া যায়নি। আবার চেষ্টা করুন।");
  const response = await fetch(storefrontPath(endpoint), { method: "POST", body, headers }).catch(() => { throw new Error(fallback); });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result?.data?.id) throw new Error(typeof result?.message === "string" ? result.message : fallback);
  return result.data;
}

type SupportItem = { id: string; productName: string; variantName: string; personalization: string };
type Replacement = { id: string; label: string; sku: string; available: number };
type ReturnItem = SupportItem & { quantity: number; replacements?: readonly Replacement[] };
type ExchangeItem = ReturnItem & { replacements: readonly Replacement[] };

export function OpenOrderCase({ orderId, available, returnItems, exchangeItems, items, language, market, routingMarket, initialItemId, immediateCancellation }: {
  orderId: string; available: readonly OrderCaseKind[]; market: MarketId; routingMarket?: MarketId; language: AccountLanguage;
  items: readonly SupportItem[]; returnItems?: readonly ReturnItem[]; exchangeItems?: readonly ExchangeItem[];
  initialItemId?: string;
  immediateCancellation?: boolean;
}) {
  const [choice, setChoice] = useState<OrderCaseKind>(initialItemId ? "DISPUTE" : available[0]);
  const kind = available.includes(choice) ? choice : available[0];
  const state = useMarketplaceSubmission();
  const [selectionError, setSelectionError] = useState("");
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const merchandise = kind === "EXCHANGE" ? exchangeItems : kind === "RETURN" ? returnItems : undefined;
  const immediate = kind === "CANCEL" && immediateCancellation;
  const actionLabel = (value: OrderCaseKind) => value === "CANCEL" && immediateCancellation
    ? t("Cancel order", "অর্ডার বাতিল করুন") : value === "EXCHANGE" ? t("Request an exchange", "পণ্য বদলের অনুরোধ করুন")
      : value === "RETURN" ? t("Request a return", "পণ্য ফেরতের অনুরোধ করুন") : caseKindLabel(language, value);

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const photo = form.get("photo");
    setSelectionError("");
    const lines = merchandise?.flatMap(item => {
      const quantity = Number(form.get("quantity-" + item.id));
      if (quantity <= 0) return [];
      const replacement = form.get("replacement-" + item.id);
      return [{ orderItemId: item.id, quantity, ...(typeof replacement === "string" && replacement && { replacementVariantId: replacement }) }];
    });
    if (lines && !lines.length) {
      setSelectionError(t("Choose at least one item and quantity.", "অন্তত একটি পণ্য ও পরিমাণ বেছে নিন।"));
      return;
    }
    if (kind === "EXCHANGE" && lines?.some(line => !line.replacementVariantId)) {
      setSelectionError(t("Choose a replacement for every item you want to exchange.", "প্রতিটি বদলের পণ্যের জন্য একটি বিকল্প বেছে নিন।"));
      return;
    }
    const command = {
      action: "open", orderId, kind, note: form.get("note"), reason: form.get("reason"),
      ...(kind === "DISPUTE" && form.get("item") && { issueItemId: form.get("item") }),
      ...(lines && { lines }),
    };
    void state.submit(() => submitCase(command, photo instanceof File ? photo : null, caseEndpoint(market, language), language),
      immediate ? t("Cancellation saved.", "বাতিলের তথ্য সংরক্ষণ হয়েছে।") : t("Your request was submitted.", "আপনার অনুরোধ জমা হয়েছে।"),
      ({ id }) => marketStoreHref("/orders/" + orderId + "/cases/" + id, routingMarket));
  }

  return <details open={initialItemId ? true : undefined}>
    <summary>{t("Start a request", "নতুন অনুরোধ করুন")}</summary>
    <form className="mp-form" method="post" onSubmit={send}>
      <label>{t("Request type", "অনুরোধের ধরন")}
        <select name="kind" value={kind} onChange={event => { setChoice(event.target.value as OrderCaseKind); setSelectionError(""); }} required>
          {available.map(item => <option key={item} value={item}>{actionLabel(item)}</option>)}
        </select>
      </label>
      {kind === "CANCEL" && <p>{immediate
        ? t("This unpaid order will be cancelled immediately.", "এই অপরিশোধিত অর্ডারটি সঙ্গে সঙ্গে বাতিল হবে।")
        : t("Support will review your cancellation. You can follow the decision and any refund here.", "সহায়তা দল বাতিলের অনুরোধ পর্যালোচনা করবে। সিদ্ধান্ত ও প্রযোজ্য টাকা ফেরতের অবস্থা এখানে দেখুন।")}</p>}
      {merchandise && <fieldset className="after-sales-items" key={kind}>
        <legend>{kind === "EXCHANGE" ? t("Items to exchange", "বদল করার পণ্য") : t("Items to return", "ফেরত দেওয়ার পণ্য")}</legend>
        {kind === "EXCHANGE" && <p>{t("Choose a same-price replacement that is in stock.", "একই দামের স্টকে থাকা বদলি পণ্য বেছে নিন।")}</p>}
        {merchandise.map(item => <fieldset className="after-sales-item" key={item.id}>
          <legend>{item.productName} · {item.variantName}{item.personalization && " · " + item.personalization}</legend>
          <label>{t("Quantity", "পরিমাণ")} ({t("up to", "সর্বোচ্চ")} {item.quantity})
            <input type="number" name={"quantity-" + item.id} min={0} max={item.quantity} step={1} defaultValue={0} />
          </label>
          {item.replacements && <label>{t("Replacement option", "বদলি পণ্য")}
            <select name={"replacement-" + item.id} defaultValue="">
              <option value="">{t("Choose an option", "একটি বিকল্প বেছে নিন")}</option>
              {item.replacements.map(variant => <option key={variant.id} value={variant.id}>
                {variant.label} · {variant.sku} ({variant.available} {t("in stock", "স্টকে")})
              </option>)}
            </select>
          </label>}
        </fieldset>)}
      </fieldset>}
      {kind === "DISPUTE" && items.length > 0 && <label>{t("Which item needs help?", "কোন পণ্য নিয়ে সহায়তা দরকার?")}
        <select name="item" defaultValue={initialItemId ?? ""}>
          <option value="">{t("Whole order", "পুরো অর্ডার")}</option>
          {items.map(item => <option key={item.id} value={item.id}>{item.productName} · {item.variantName}{item.personalization && " · " + item.personalization}</option>)}
        </select>
      </label>}
      <label>{t("Reason", "কারণ")}
        <select name="reason" required defaultValue="">
          <option value="">{t("Choose a reason", "একটি কারণ বেছে নিন")}</option>
          {caseReasons.map(reason => <option key={reason} value={reason}>{caseReasonLabel(language, reason)}</option>)}
        </select>
      </label>
      <label>{t("What happened?", "কী হয়েছে?")}
        <textarea name="note" required minLength={10} maxLength={1500} rows={4} />
        <small>{t("Enter at least 10 characters.", "অন্তত ১০টি অক্ষর লিখুন।")}</small>
      </label>
      {kind !== "CANCEL" && <label>{t("Add a photo (optional)", "ছবি যোগ করুন (ঐচ্ছিক)")}
        <input type="file" name="photo" accept="image/jpeg,image/png,image/webp" />
        <small>{t("JPEG, PNG or WebP, up to 4 MB.", "JPEG, PNG বা WebP, সর্বোচ্চ ৪ এমবি।")}</small>
      </label>}
      {immediate && <label><input type="checkbox" required /> {t("I want to cancel this order.", "আমি এই অর্ডারটি বাতিল করতে চাই।")}</label>}
      <button type="submit" className="button button--primary" disabled={state.pending}>
        {state.pending ? t("Submitting…", "জমা হচ্ছে…") : immediate ? t("Cancel order", "অর্ডার বাতিল করুন") : t("Submit request", "অনুরোধ জমা দিন")}
      </button>
      {selectionError && <p role="alert">{selectionError}</p>}
      {state.feedback}
    </form>
  </details>;
}

type CaseState = { id: string; revision: number; status: OrderCaseStatus };

export function ShopperCaseActions({ orderCase, market, language }: { orderCase: CaseState; market: MarketId; language: AccountLanguage }) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const endpoint = caseEndpoint(market, language);
  return <>
    {activeCaseStatuses.some(status => status === orderCase.status) && <section className="commerce-panel">
      <h2>{t("Reply to support", "সহায়তা দলকে উত্তর দিন")}</h2>
      <MarketplaceForm endpoint={endpoint} label={t("Send reply", "উত্তর পাঠান")} success={t("Reply sent.", "উত্তর পাঠানো হয়েছে।")}
        pendingLabel={t("Sending…", "পাঠানো হচ্ছে…")} reset
        fields={<label>{t("Message", "বার্তা")}<textarea name="note" required minLength={3} maxLength={1500} rows={3} /></label>}
        command={form => ({ action: "reply", caseId: orderCase.id, revision: orderCase.revision, note: form.get("note") })}
      />
    </section>}
    {mayWithdrawCase(orderCase.status) && <details>
      <summary>{t("Withdraw this request", "অনুরোধ প্রত্যাহার করুন")}</summary>
      <MarketplaceForm endpoint={endpoint} label={t("Confirm withdrawal", "প্রত্যাহার নিশ্চিত করুন")}
        success={t("The request was withdrawn.", "অনুরোধটি প্রত্যাহার করা হয়েছে।")} pendingLabel={t("Saving…", "সংরক্ষণ হচ্ছে…")}
        command={() => ({ action: "withdraw", caseId: orderCase.id, revision: orderCase.revision })}
      />
    </details>}
  </>;
}
