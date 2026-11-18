import { ArrowUpRight, Bell, CircleDollarSign, Package } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { AccountFrame } from "@/components/marketplace/account-frame";
import { SignInGate } from "@/components/marketplace/session";
import type { MarketId } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { customerOrderDate } from "@/lib/commerce/account-order";
import { currentMarket } from "@/lib/market-server";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";
import { getShopper } from "@/lib/marketplace/auth";
import { caseKindLabel, caseStatusLabel } from "@/lib/marketplace/case-language";
import { orderCenterEnabled } from "@/lib/marketplace/order-center-config";
import { orderNoticeFilter, readNoticeCursor, shopOrderNotifications,
  type OrderNoticeFilter, type ShopOrderNotice } from "@/lib/marketplace/order-notification-inbox";
import { NotificationReadButton } from "./read-button";
import "./order-inbox.css";

const orderMilestones = {
  PLACED: ["Order received", "অর্ডার গ্রহণ করা হয়েছে"],
  PACKING: ["Order is being packed", "অর্ডার প্যাক করা হচ্ছে"],
  READY_TO_SHIP: ["Order ready to ship", "অর্ডার পাঠানোর জন্য প্রস্তুত"],
  SHIPPED: ["Order shipped", "অর্ডার পাঠানো হয়েছে"],
  IN_TRANSIT: ["Order shipped", "অর্ডার পাঠানো হয়েছে"],
  OUT_FOR_DELIVERY: ["Order out for delivery", "অর্ডার ডেলিভারির পথে"],
  DELIVERED: ["Order delivered", "অর্ডার পৌঁছে দেওয়া হয়েছে"],
  REFUSED: ["Delivery was refused", "ডেলিভারি গ্রহণ করা হয়নি"],
  RETURNED_TO_STORE: ["Parcel returned to GriipBuddy", "প্যাকেট GriipBuddy-তে ফেরত এসেছে"],
  CASH_COLLECTED: ["Cash payment collected", "নগদ পেমেন্ট গ্রহণ করা হয়েছে"],
  PAYMENT_CONFIRMED: ["Payment confirmed", "পেমেন্ট নিশ্চিত হয়েছে"],
  CANCELLED: ["Order cancelled", "অর্ডার বাতিল হয়েছে"],
} as const;

const refundMilestones = {
  REFUND_REQUESTED: ["Refund requested", "টাকা ফেরতের অনুরোধ করা হয়েছে"],
  REFUND_APPROVED: ["Refund approved", "টাকা ফেরত অনুমোদিত হয়েছে"],
  REFUND_FAILED: ["Refund payout needs attention", "টাকা ফেরতের পরিশোধে সমস্যা হয়েছে"],
  REFUND_CONFIRMED: ["Refund confirmed", "টাকা ফেরত নিশ্চিত হয়েছে"],
} as const;

function noticeTitle(notice: ShopOrderNotice, language: AccountLanguage) {
  if (notice.type === "case") return `${caseKindLabel(language, notice.caseKind)} · ${caseStatusLabel(language, notice.status)}`;
  const [english, bangla] = notice.type === "order" ? orderMilestones[notice.status] : refundMilestones[notice.status];
  return accountText(language, english, bangla);
}

function noticesHref(market: MarketId, filter: OrderNoticeFilter, orderId?: string, before?: string) {
  const query = new URLSearchParams();
  if (filter !== "all") query.set("filter", filter);
  if (orderId) query.set("order", orderId);
  if (before) query.set("before", before);
  return marketStoreHref("/account/notifications" + (query.size ? `?${query}` : ""), market);
}

export async function generateMetadata() {
  return { title: accountText(await currentAccountLanguage(), "Notifications", "বিজ্ঞপ্তি"), robots: { index: false, follow: false } };
}

type NoticeParams = { order?: string | string[]; filter?: string | string[]; before?: string | string[] };

export default async function OrderNotificationsPage({ searchParams }: { searchParams: Promise<NoticeParams> }) {
  const { id: market } = await currentMarket();
  if (!orderCenterEnabled(market)) notFound();
  const [shopper, language, params] = await Promise.all([getShopper(), currentAccountLanguage(market), searchParams]);
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const parsedOrderId = z.uuid().safeParse(params.order);
  const orderId = parsedOrderId.success ? parsedOrderId.data : undefined;
  const filter = orderNoticeFilter.safeParse(params.filter).data ?? "all";
  const before = readNoticeCursor(params.before);
  const labels = {
    all: t("All updates", "সব আপডেট"),
    orders: t("Orders", "অর্ডার"),
    refunds: t("Refunds", "টাকা ফেরত"),
  } satisfies Record<OrderNoticeFilter, string>;
  const { notices, next } = shopper ? await shopOrderNotifications(shopper.id, market, { orderId, filter, before }) : { notices: [], next: null };
  const unreadKeys = notices.filter(notice => !notice.read).map(notice => notice.key);

  return <AccountFrame market={market} hybrid language={language} section="notifications">
    {!shopper ? <SignInGate language={language}>{t("Sign in to view your order and refund updates.",
      "অর্ডার ও টাকা ফেরতের আপডেট দেখতে সাইন ইন করুন।")}</SignInGate> : <div className="order-inbox">
      <div className="order-inbox__toolbar">
        <nav className="order-inbox__filters" aria-label={t("Filter notifications", "বিজ্ঞপ্তি বাছাই করুন")}>
          {orderNoticeFilter.options.map(option => <Link key={option} aria-current={option === filter ? "page" : undefined}
            href={noticesHref(market, option, orderId)}>{labels[option]}</Link>)}
        </nav>
        {unreadKeys.length > 1 && <NotificationReadButton keys={unreadKeys} language={language} market={market}
          label={t("Mark page as read", "এই পৃষ্ঠার বিজ্ঞপ্তি পড়া হয়েছে")}/>}
      </div>
      {orderId && <Link className="order-inbox__reset" href={noticesHref(market, filter)}>{t("Show updates for all orders", "সব অর্ডারের আপডেট দেখুন")}</Link>}
      {notices.length ? <ol className="order-inbox__list">
        {notices.map(notice => {
          const title = noticeTitle(notice, language);
          const orderPath = `/orders/${notice.orderId}`;
          const casePath = notice.caseId ? `/cases/${notice.caseId}` : "";
          const link = marketStoreHref(orderPath + casePath + (notice.type === "refund" ? "#refund-progress" : ""), market);
          const Icon = notice.type === "refund" ? CircleDollarSign : notice.type === "case" ? Bell : Package;
          return <li className="order-inbox__item" key={notice.key} data-unread={!notice.read || undefined}>
            <span className="order-inbox__icon"><Icon size={20} aria-hidden="true" /></span>
            <div className="order-inbox__body">
              <div className="order-inbox__title">
                <h2><Link href={link}>{title}<ArrowUpRight size={16} aria-hidden="true" /></Link></h2>
                {!notice.read && <span>{t("Unread", "অপঠিত")}</span>}
              </div>
              <p><strong>{notice.reference}</strong><span aria-hidden="true">·</span>
                <time dateTime={notice.at.toISOString()}>{customerOrderDate(notice.at, market, language, true)}</time></p>
            </div>
            {!notice.read && <NotificationReadButton keys={[notice.key]} language={language} market={market}
              context={`${title} · ${notice.reference}`} label={t("Mark as read", "পড়া হয়েছে")} />}
          </li>;
        })}
      </ol> : <section className="commerce-panel order-inbox__empty">
        <span className="order-inbox__icon"><Bell size={21} aria-hidden="true" /></span>
        <h2>{t("No updates to show", "দেখানোর মতো আপডেট নেই")}</h2>
        <Link href={marketStoreHref("/orders", market)}>{t("Go to My Orders", "আমার অর্ডারে যান")}</Link>
      </section>}
      {(before || next) && <nav className="order-inbox__paging" aria-label={t("Notification pages", "বিজ্ঞপ্তির পৃষ্ঠাগুলো")}>
        {before && <Link href={noticesHref(market, filter, orderId)}>{t("Newest updates", "সাম্প্রতিক আপডেট")}</Link>}
        {next && <Link href={noticesHref(market, filter, orderId, next)}>{t("Older updates", "পুরোনো আপডেট")}</Link>}
      </nav>}
    </div>}
  </AccountFrame>;
}
