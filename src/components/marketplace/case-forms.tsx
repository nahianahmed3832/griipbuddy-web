"use client";

import { useState, type FormEvent } from "react";
import type { MarketId } from "@/config/markets";
import { formatMoney, markets } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import type { OrderCaseKind, OrderCaseStatus } from "@/generated/prisma/enums";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import { caseKindLabel, caseReasonLabel } from "@/lib/marketplace/case-language";
import { activeCaseStatuses, caseReasons, caseStatusLabels, mayWithdrawCase, ownerCaseTransitions } from "@/lib/marketplace/case-policy";
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

export function OpenOrderCase({ orderId, available, returnItems, items, language, market, routingMarket, initialItemId }: {
  orderId: string; available: readonly OrderCaseKind[]; market: MarketId; routingMarket?: MarketId; language: AccountLanguage;
  items: readonly SupportItem[]; returnItems?: readonly (SupportItem & { quantity: number })[];
  initialItemId?: string;
}) {
  const [choice, setChoice] = useState(available[0]);
  const kind = available.includes(choice) ? choice : available[0];
  const state = useMarketplaceSubmission();
  const t = (en: string, bn: string) => accountText(language, en, bn);

  function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const photo = form.get("photo");
    const command = {
      action: "open", orderId, kind, note: form.get("note"), reason: form.get("reason"),
      ...(kind === "DISPUTE" && form.get("item") && { issueItemId: form.get("item") }),
      ...(kind === "RETURN" && returnItems && {
        lines: returnItems.flatMap(item => {
          const quantity = Number(form.get("quantity-" + item.id));
          return quantity > 0 ? [{ orderItemId: item.id, quantity }] : [];
        }),
      }),
    };
    void state.submit(() => submitCase(command, photo instanceof File ? photo : null, caseEndpoint(market, language), language),
      t("Your request was submitted.", "আপনার অনুরোধ জমা হয়েছে।"),
      ({ id }) => marketStoreHref("/orders/" + orderId + "/cases/" + id, routingMarket));
  }

  return <details open={initialItemId ? true : undefined}>
    <summary>{t("Start a request", "নতুন অনুরোধ করুন")}</summary>
    <form className="mp-form" onSubmit={send}>
      <label>{t("Request type", "অনুরোধের ধরন")}
        <select name="kind" value={kind} onChange={event => setChoice(event.target.value as OrderCaseKind)} required>
          {available.map(item => <option key={item} value={item}>{caseKindLabel(language, item)}</option>)}
        </select>
      </label>
      {kind === "RETURN" && returnItems && <fieldset>
        <legend>{t("Items to return", "ফেরত দেওয়ার পণ্য")}</legend>
        <p>{t("Enter a quantity for each item you want to return.", "প্রতিটি পণ্যের জন্য কতটি ফেরত দিতে চান তা লিখুন।")}</p>
        {returnItems.map(item => <label key={item.id}>
          {item.productName} · {item.variantName}{item.personalization && " · " + item.personalization} ({t("up to", "সর্বোচ্চ")} {item.quantity})
          <input type="number" name={"quantity-" + item.id} min={0} max={item.quantity} step={1} defaultValue={0} />
        </label>)}
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
      <button type="submit" className="button button--primary" disabled={state.pending}>
        {state.pending ? t("Submitting…", "জমা হচ্ছে…") : t("Submit request", "অনুরোধ জমা দিন")}
      </button>
      {state.feedback}
    </form>
  </details>;
}

type CaseState = { id: string; revision: number; kind: OrderCaseKind; status: OrderCaseStatus; returnLineCount: number };

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

export function ReviewOrderCase({ orderCase, market }: { orderCase: CaseState; market: MarketId }) {
  const endpoint = caseEndpoint(market);
  const hasReturnLines = orderCase.returnLineCount > 0;
  const options = ownerCaseTransitions(orderCase.kind, orderCase.status, hasReturnLines);
  if (orderCase.kind === "RETURN" && orderCase.status === "RETURN_APPROVED" && hasReturnLines) {
    return <section className="commerce-panel">
      <h2>Receive returned items</h2>
      <p>Match the physical items and quantities to this case. Handle any refund separately before resolving the case.</p>
      <MarketplaceForm endpoint={endpoint} label="Record return receipt" success="Return receipt recorded."
        fields={<>
          <label>Stock decision
            <select name="disposition" required defaultValue="">
              <option value="" disabled>Choose after inspection</option>
              <option value="RESTOCK">Restock all returned items that are complete and sellable</option>
              <option value="HOLD">Hold damaged or uncertain items for review</option>
            </select>
          </label>
          <label><input name="confirmed" type="checkbox" value="yes" required /> I received and inspected every item listed in this case.</label>
        </>}
        command={form => ({ action: "receive", caseId: orderCase.id, revision: orderCase.revision,
          disposition: form.get("disposition"), confirmed: form.get("confirmed") === "yes" })}
      />
    </section>;
  }
  if (!options.length) return null;
  return <section className="commerce-panel">
    <h2>Review case</h2>
    {orderCase.kind === "CANCEL" && <p>Open the original order above to cancel it using the existing staff controls, then resolve this request.</p>}
    <MarketplaceForm endpoint={endpoint} label="Save case update" success="Case updated." reset
      fields={<>
        <label>New status
          <select name="status" required>
            {options.map(status => <option key={status} value={status}>{caseStatusLabels[status]}</option>)}
          </select>
        </label>
        <label>Message to shopper<textarea name="note" rows={4} minLength={3} maxLength={1500} required /></label>
        {options.includes("RETURN_APPROVED") && <p>Include return instructions when you approve a return.</p>}
        {orderCase.status === "RETURN_RECEIVED" && <p>Confirm any required refund before resolving the case.</p>}
      </>}
      command={form => ({ action: "review", caseId: orderCase.id, revision: orderCase.revision, status: form.get("status"), note: form.get("note") })}
    />
  </section>;
}

export function StaffCaseReply({ orderCase, market }: { orderCase: CaseState; market: MarketId }) {
  if (!activeCaseStatuses.some(status => status === orderCase.status)) return null;
  return <section className="commerce-panel">
    <h2>Reply to shopper</h2>
    <MarketplaceForm endpoint={caseEndpoint(market)} label="Send reply" success="Reply sent." reset
      fields={<label>Message<textarea name="note" required minLength={3} maxLength={1500} rows={3} /></label>}
      command={form => ({ action: "respond", caseId: orderCase.id, revision: orderCase.revision, note: form.get("note") })} />
  </section>;
}

export function ConfirmCaseRefund({ orderCase, limitMinor }: { orderCase: CaseState; limitMinor: number }) {
  if (limitMinor < 1) return null;
  return <section className="commerce-panel">
    <h2>Record a completed refund</h2>
    <p>Only record a refund after the payout is complete. Maximum for these returned items is {formatMoney(limitMinor, markets.bd)}.</p>
    <MarketplaceForm endpoint={caseEndpoint("bd")} label="Confirm completed refund" success="Refund confirmation recorded."
      fields={<>
        <label>Amount refunded (BDT)<input name="amount" type="number" min="0.01" max={limitMinor / 100} step="0.01" required /></label>
        <label>Method used<input name="method" minLength={2} maxLength={60} required /></label>
        <label>Confirmation reference<input name="reference" minLength={2} maxLength={80} required /></label>
        <label><input name="confirmed" type="checkbox" value="yes" required /> I verified the completed payout and amount.</label>
      </>}
      command={form => ({ action: "confirm-refund", caseId: orderCase.id, revision: orderCase.revision,
        amountMinor: Math.round(Number(form.get("amount")) * 100), method: form.get("method"), reference: form.get("reference"),
        confirmed: form.get("confirmed") === "yes" })}
    />
  </section>;
}
