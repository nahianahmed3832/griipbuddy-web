import Link from "next/link";
import type { MarketId } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import { orderDate } from "@/lib/commerce/labels";
import { customerOrderMoney } from "@/lib/commerce/account-order";
import type { SavedOrder } from "@/lib/commerce/orders";
import { purchaseCaseOptions } from "@/lib/commerce/order-return-terms";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import { caseKindLabel, caseProgressLabel, caseReasonLabel, caseStatusLabel } from "@/lib/marketplace/case-language";
import { activeCaseStatuses, mayCancelBangladeshOrderImmediately, mayRequestBangladeshCancellation, mayRequestCancellation, mayRequestExchange, mayRequestReturn } from "@/lib/marketplace/case-policy";
import { casesForPurchase, casesForStaffOrder, exchangeVariantsForPurchase, itemsForSupport, returnItemsForPurchase, type OrderCaseDetail, type OrderCaseSummary } from "@/lib/marketplace/cases";
import { OpenOrderCase } from "./case-forms";

function CaseLinks({ rows, href, language }: { rows: OrderCaseSummary[]; href: (id: string) => string; language: AccountLanguage }) {
  return <ul className="mp-editor-list">
    {rows.map(row => <li key={row.id}>
      <Link href={href(row.id)}>{caseKindLabel(language, row.kind)} · {caseProgressLabel(language, row)}</Link>
    </li>)}
  </ul>;
}

export async function PurchaseCases({ order, shopperId, market, language = "en", initialItemId }: {
  order: SavedOrder; shopperId: string; market?: MarketId; language?: AccountLanguage;
  initialItemId?: string;
}) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const marketId = order.marketId;
  const bangladesh = marketId === "bd";
  const options = purchaseCaseOptions(order);
  const canStartReturn = options.returnRequest !== "support" && mayRequestReturn(order);
  const [rows, returnItems, items] = await Promise.all([
    casesForPurchase(order.id, shopperId, marketId),
    options.returnRequest === "item" && canStartReturn ? returnItemsForPurchase(order.id, shopperId) : undefined,
    itemsForSupport(order.id, shopperId, marketId),
  ]);
  const hasOpenCase = (kind: OrderCaseSummary["kind"]) =>
    rows.some(row => row.kind === kind && activeCaseStatuses.some(status => status === row.status));
  const hasOpenReturnOrExchange = hasOpenCase("RETURN") || hasOpenCase("EXCHANGE");
  const replacements = !hasOpenReturnOrExchange && returnItems?.length && mayRequestExchange(order)
    ? await exchangeVariantsForPurchase(order.id, shopperId, returnItems.map(item => item.id)) : undefined;
  const exchangeItems = returnItems?.flatMap(item => {
    const variants = replacements?.get(item.id);
    return variants?.length ? [{ ...item, replacements: variants }] : [];
  });
  const available: OrderCaseSummary["kind"][] = [];
  if (options.onlineCancellation && (bangladesh ? mayRequestBangladeshCancellation(order) : mayRequestCancellation(order)) && !hasOpenCase("CANCEL")) available.push("CANCEL");
  if (canStartReturn && !hasOpenReturnOrExchange && (!returnItems || returnItems.length > 0)) available.push("RETURN");
  if (exchangeItems?.length) available.push("EXCHANGE");
  if (!hasOpenCase("DISPUTE")) available.push("DISPUTE");
  const selectedItem = available.includes("DISPUTE") && items.some(item => item.id === initialItemId) ? initialItemId : undefined;

  return <section className="commerce-panel" id="order-support">
    <h2>{bangladesh ? t("Manage this order", "এই অর্ডার পরিচালনা করুন") : t("Help and returns", "সহায়তা ও ফেরত")}</h2>
    {rows.length > 0 && <CaseLinks rows={rows} language={language} href={id => marketStoreHref("/orders/" + order.id + "/cases/" + id, market)} />}
    {options.returnRequest === "support" && <p>{t("Contact support to discuss a return for this order.",
      "এই অর্ডার ফেরত দেওয়ার বিষয়ে সহায়তা দলের সঙ্গে যোগাযোগ করুন।")}</p>}
    {options.returnRequest !== "support" && !canStartReturn && order.status === "PLACED" && <p>{bangladesh
      ? t("Return and exchange requests open after delivery.", "ডেলিভারির পরে ফেরত ও বদলের অনুরোধ করা যায়।")
      : t("Return requests open after delivery.", "ডেলিভারির পরে ফেরতের অনুরোধ করা যায়।")}</p>}
    {canStartReturn && returnItems?.length === 0 && <p>{t("No items are available to return online. Contact GriipBuddy if you need help.",
      "অনলাইনে ফেরত দেওয়ার মতো পণ্য নেই। সহায়তার প্রয়োজন হলে GriipBuddy-এর সঙ্গে যোগাযোগ করুন।")}</p>}
    {available.length > 0 && <OpenOrderCase key={selectedItem ?? order.id} orderId={order.id} available={available}
      immediateCancellation={bangladesh && mayCancelBangladeshOrderImmediately(order)} items={items} returnItems={returnItems} exchangeItems={exchangeItems}
      language={language} market={marketId} routingMarket={market} initialItemId={selectedItem} />}
  </section>;
}

export async function StaffOrderCases({ orderId, staffId }: { orderId: string; staffId: string }) {
  const rows = await casesForStaffOrder(staffId, orderId);
  if (!rows.length) return null;
  return <section className="commerce-panel">
    <h2>Order cases</h2>
    <CaseLinks rows={rows} language="en" href={id => "/staff/cases/" + id} />
  </section>;
}

export function CaseHistory({ orderCase, language = "en", staff = false }: { orderCase: OrderCaseDetail; language?: AccountLanguage; staff?: boolean }) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const market = orderCase.order.marketId;
  const date = (value: Date) => language === "bn"
    ? new Intl.DateTimeFormat("bn-BD", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Dhaka" }).format(value)
    : orderDate(value, market);
  const photoHref = storefrontPath("/api/marketplace/cases?" +
    new URLSearchParams({ photo: orderCase.id, market, ...(staff && { staff: "1" }) }));
  return <>
    {(orderCase.reason || orderCase.issueItem || orderCase.attachment) && <section className="commerce-panel">
      <h2>{t("Request details", "অনুরোধের বিবরণ")}</h2>
      {orderCase.reason && <p>{t("Reason", "কারণ")} · {caseReasonLabel(language, orderCase.reason)}</p>}
      {orderCase.issueItem && <p>{t("Item", "পণ্য")} · {orderCase.issueItem.productName} · {orderCase.issueItem.variantName}</p>}
      {orderCase.attachment && <p><a href={photoHref}>{t("Download attached photo", "সংযুক্ত ছবি ডাউনলোড করুন")}</a></p>}
    </section>}
    {orderCase.returnLines.length > 0 && <section className="commerce-panel">
      <h2>{orderCase.kind === "EXCHANGE" ? t("Items in this exchange", "এই বদলের পণ্য") : t("Items in this return", "এই ফেরতের পণ্য")}</h2>
      <ul className="staff-history">
        {orderCase.returnLines.map(({ orderItem, quantity, replacementVariantName }) => <li key={orderItem.id}>
          <strong>{orderItem.productName} · {orderItem.variantName}</strong>
          <span>{t("Quantity", "পরিমাণ")} · {quantity}</span>
          {replacementVariantName && <p>{t("Replacement", "বদলি পণ্য")} · {replacementVariantName}</p>}
          {orderItem.personalization && <p className="break-words">{orderItem.personalization}</p>}
        </li>)}
      </ul>
    </section>}
    {orderCase.kind === "EXCHANGE" && orderCase.replacementTrackingReference && <section className="commerce-panel">
      <h2>{t("Replacement shipment", "বদলি পণ্যের পার্সেল")}</h2>
      <p>{orderCase.replacementCarrier && orderCase.replacementCarrier + " · "}{orderCase.replacementTrackingReference}</p>
    </section>}
    {market === "bd" && <RefundProgress orderCase={orderCase} language={language} date={date} />}
    <section className="commerce-panel">
      <h2>{t("Messages and updates", "বার্তা ও আপডেট")}</h2>
      <ol className="staff-history">
        {orderCase.events.map((event, index) => <li key={event.revision}>
          <strong>{event.refundConfirmed ? t("Refund confirmed", "টাকা ফেরত নিশ্চিত হয়েছে")
            : event.note && orderCase.events[index - 1]?.status === event.status
              ? event.shopperActorId ? t("Shopper reply", "ক্রেতার উত্তর") : t("Support reply", "সহায়তা দলের উত্তর")
              : caseStatusLabel(language, event.status)}</strong>
          <span>{date(event.createdAt)}</span>
          {event.note && <p className="whitespace-pre-wrap break-words">{event.note}</p>}
        </li>)}
      </ol>
    </section>
  </>;
}

function RefundProgress({ orderCase, language, date }: { orderCase: OrderCaseDetail; language: AccountLanguage; date: (when: Date) => string }) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const { status, kind, refundAmountMinor, refundConfirmedAt, refundMethod } = orderCase;
  const pending = status === "REFUND_APPROVED" || status === "REFUND_FAILED";
  const returnUnderReview = kind === "RETURN" && (status === "OPEN" || status === "IN_REVIEW" || status === "RETURN_APPROVED" || status === "RETURN_RECEIVED");
  if (!refundConfirmedAt && !pending && !returnUnderReview) return null;

  const message = refundConfirmedAt ? null
    : status === "REFUND_APPROVED" ? t("Your refund is approved. We’ll update this page when the payout is confirmed.", "টাকা ফেরত অনুমোদিত হয়েছে। পরিশোধ নিশ্চিত হলে এই পৃষ্ঠায় জানানো হবে।")
      : status === "REFUND_FAILED" ? t("There was a problem with the payout. Follow the updates below for support’s next step.", "পরিশোধে সমস্যা হয়েছে। সহায়তা দলের পরবর্তী পদক্ষেপ জানতে নিচের আপডেট দেখুন।")
        : status === "RETURN_APPROVED" ? t("Follow the return instructions below. Refund review continues after we receive the items.", "নিচের ফেরতের নির্দেশনা অনুসরণ করুন। পণ্য পাওয়ার পর টাকা ফেরতের পর্যালোচনা চলবে।")
          : status === "RETURN_RECEIVED" ? t("Your returned items arrived. Support will confirm the amount if a refund applies.", "ফেরত পণ্য পাওয়া গেছে। টাকা ফেরত প্রযোজ্য হলে সহায়তা দল পরিমাণ নিশ্চিত করবে।")
            : t("Support is reviewing your return request.", "সহায়তা দল আপনার ফেরতের অনুরোধ পর্যালোচনা করছে।");
  return <section className="commerce-panel commerce-summary" id="refund-progress">
    <h2>{t("Refund status", "টাকা ফেরতের অবস্থা")}</h2>
    <dl>
      <div><dt>{t("Status", "অবস্থা")}</dt><dd>{caseProgressLabel(language, orderCase)}</dd></div>
      {refundAmountMinor !== null && <div><dt>{t("Amount", "পরিমাণ")}</dt>
        <dd>{customerOrderMoney(refundAmountMinor, orderCase.order.currency, language)} {orderCase.order.currency}</dd></div>}
      {refundConfirmedAt && refundMethod && <div><dt>{t("Method", "পদ্ধতি")}</dt><dd>{refundMethod}</dd></div>}
      {refundConfirmedAt && <div><dt>{t("Confirmed on", "নিশ্চিত করার সময়")}</dt><dd>{date(refundConfirmedAt)}</dd></div>}
    </dl>
    {message && <p>{message}</p>}
  </section>;
}
