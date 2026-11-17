import Link from "next/link";
import type { MarketId } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import { orderDate } from "@/lib/commerce/labels";
import { customerOrderMoney } from "@/lib/commerce/account-order";
import { purchaseCaseOptions } from "@/lib/commerce/order-return-terms";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import { caseKindLabel, caseReasonLabel, caseStatusLabel } from "@/lib/marketplace/case-language";
import { activeCaseStatuses, mayRequestCancellation, mayRequestReturn } from "@/lib/marketplace/case-policy";
import { casesForPurchase, casesForStaffOrder, itemsForSupport, returnItemsForPurchase, type OrderCaseDetail, type OrderCaseSummary } from "@/lib/marketplace/cases";
import { OpenOrderCase } from "./case-forms";

function CaseLinks({ rows, href, language }: { rows: OrderCaseSummary[]; href: (id: string) => string; language: AccountLanguage }) {
  return <ul className="mp-editor-list">
    {rows.map(row => <li key={row.id}>
      <Link href={href(row.id)}>{caseKindLabel(language, row.kind)} · {caseStatusLabel(language, row.status)}</Link>
    </li>)}
  </ul>;
}

export async function PurchaseCases({ order, shopperId, market, language = "en", initialItemId }: {
  order: { id: string; status: string; fulfillmentStatus: string; marketId: MarketId; returnTerms: unknown }; shopperId: string; market?: MarketId; language?: AccountLanguage;
  initialItemId?: string;
}) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const marketId = order.marketId;
  const options = purchaseCaseOptions(order);
  const canStartReturn = options.returnRequest !== "support" && mayRequestReturn(order);
  const [rows, returnItems, items] = await Promise.all([
    casesForPurchase(order.id, shopperId, marketId),
    options.returnRequest === "item" && canStartReturn ? returnItemsForPurchase(order.id, shopperId) : undefined,
    itemsForSupport(order.id, shopperId, marketId),
  ]);
  const hasOpenCase = (kind: OrderCaseSummary["kind"]) =>
    rows.some(row => row.kind === kind && activeCaseStatuses.some(status => status === row.status));
  const available: OrderCaseSummary["kind"][] = [];
  if (!hasOpenCase("DISPUTE")) available.push("DISPUTE");
  if (canStartReturn && !hasOpenCase("RETURN") && (!returnItems || returnItems.length > 0)) available.push("RETURN");
  if (options.onlineCancellation && mayRequestCancellation(order) && !hasOpenCase("CANCEL")) available.push("CANCEL");
  const selectedItem = available.includes("DISPUTE") && items.some(item => item.id === initialItemId) ? initialItemId : undefined;

  return <section className="commerce-panel" id="order-support">
    <h2>{t("Help and returns", "সহায়তা ও ফেরত")}</h2>
    {rows.length > 0 && <CaseLinks rows={rows} language={language} href={id => marketStoreHref("/orders/" + order.id + "/cases/" + id, market)} />}
    {options.returnRequest === "support" && <p>{t("Contact support to discuss a return for this order.",
      "এই অর্ডার ফেরত দেওয়ার বিষয়ে সহায়তা দলের সঙ্গে যোগাযোগ করুন।")}</p>}
    {options.returnRequest !== "support" && !canStartReturn && order.status === "PLACED" && <p>{t("Return requests open after delivery.", "ডেলিভারির পরে ফেরতের অনুরোধ করা যায়।")}</p>}
    {canStartReturn && returnItems?.length === 0 && <p>{t("No items are available to return online. Contact GriipBuddy if you need help.",
      "অনলাইনে ফেরত দেওয়ার মতো পণ্য নেই। সহায়তার প্রয়োজন হলে GriipBuddy-এর সঙ্গে যোগাযোগ করুন।")}</p>}
    {available.length > 0 && <OpenOrderCase key={selectedItem ?? order.id} orderId={order.id} available={available} items={items} returnItems={returnItems}
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
      <h2>{t("Items in this return", "এই ফেরতের পণ্য")}</h2>
      <ul className="staff-history">
        {orderCase.returnLines.map(({ orderItem, quantity }) => <li key={orderItem.id}>
          <strong>{orderItem.productName} · {orderItem.variantName}</strong>
          <span>{t("Quantity", "পরিমাণ")} · {quantity}</span>
          {orderItem.personalization && <p className="break-words">{orderItem.personalization}</p>}
        </li>)}
      </ul>
    </section>}
    {orderCase.refundConfirmedAt && orderCase.refundMethod && orderCase.refundAmountMinor !== null && <section className="commerce-panel">
      <h2>{t("Refund confirmed", "টাকা ফেরত নিশ্চিত হয়েছে")}</h2>
      <dl>
        <div><dt>{t("Amount", "পরিমাণ")}</dt><dd>{customerOrderMoney(orderCase.refundAmountMinor, orderCase.order.currency, language)} {orderCase.order.currency}</dd></div>
        <div><dt>{t("Method", "পদ্ধতি")}</dt><dd>{orderCase.refundMethod}</dd></div>
        <div><dt>{t("Confirmed on", "নিশ্চিত করার সময়")}</dt><dd>{date(orderCase.refundConfirmedAt)}</dd></div>
      </dl>
    </section>}
    {orderCase.kind === "RETURN" && orderCase.status === "RETURN_RECEIVED" && !orderCase.refundConfirmedAt && <p className="commerce-panel">
      {t("Support will confirm the refund method and amount if a refund applies.",
        "টাকা ফেরত প্রযোজ্য হলে সহায়তা দল পরিমাণ ও পদ্ধতি নিশ্চিত করবে।")}
    </p>}
    <section className="commerce-panel">
      <h2>{t("Messages and updates", "বার্তা ও আপডেট")}</h2>
      <ol className="staff-history">
        {orderCase.events.map((event, index) => <li key={event.revision}>
          <strong>{event.refundConfirmed ? t("Refund confirmed", "টাকা ফেরত নিশ্চিত হয়েছে")
            : event.shopperActorId && event.revision > 0 && event.status !== "WITHDRAWN" ? t("Shopper reply", "ক্রেতার উত্তর")
              : event.note && orderCase.events[index - 1]?.status === event.status ? t("Support reply", "সহায়তা দলের উত্তর")
                : caseStatusLabel(language, event.status)}</strong>
          <span>{date(event.createdAt)}</span>
          {event.note && <p className="whitespace-pre-wrap break-words">{event.note}</p>}
        </li>)}
      </ol>
    </section>
  </>;
}
