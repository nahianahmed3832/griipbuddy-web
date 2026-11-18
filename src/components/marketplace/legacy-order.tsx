import Link from "next/link";
import { customerOrderDate, customerOrderMoney } from "@/lib/commerce/account-order";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import type { LegacyOrder } from "@/lib/marketplace/bd-order-hub-bridge";

const banglaStatuses: Record<string, string> = {
  HANDED_OVER_TO_COURIER: "কুরিয়ারে দেওয়া হয়েছে", IN_TRANSIT: "পথে আছে", DELIVERED: "ডেলিভারি সম্পন্ন",
  RETURNED: "ফেরত এসেছে", CANCELLED: "বাতিল হয়েছে", INCOMPLETE: "নিশ্চিত করার অপেক্ষায়",
  PLACED: "অর্ডার করা হয়েছে", IN_REVIEW: "পর্যালোচনা চলছে", PENDING_RETURN: "ফেরতের অপেক্ষায়",
  FAILED: "অর্ডার ব্যর্থ হয়েছে", RETURN_REQUESTED: "ফেরতের অনুরোধ করা হয়েছে", NO_RESPONSE: "উত্তরের অপেক্ষায়",
  FULL_RETURNED: "ফেরত এসেছে", PARTIAL: "আংশিক ফেরত", PRE_ORDER: "প্রি-অর্ডার",
  PROCESSING: "প্রক্রিয়াধীন", AWAITING_STOCK: "স্টকের অপেক্ষায়", ACCEPTED: "গৃহীত হয়েছে",
  REQUESTED: "অনুরোধ করা হয়েছে", QUOTED: "মূল্য প্রস্তাব প্রস্তুত", CONFIRMED: "নিশ্চিত হয়েছে",
  PURCHASED: "কেনা হয়েছে", SHIPPED_TO_BD: "বাংলাদেশের পথে", ARRIVED_IN_BD: "বাংলাদেশে পৌঁছেছে",
  READY_FOR_DELIVERY: "ডেলিভারির জন্য প্রস্তুত", ON_HOLD: "স্থগিত", UNKNOWN: "অবস্থা জানা যায়নি",
};

const banglaPayments: Record<string, string> = {
  "Awaiting quote": "মূল্য প্রস্তাবের অপেক্ষায়", Paid: "পরিশোধ করা হয়েছে", "Advance recorded": "অগ্রিম জমা হয়েছে",
  "Advance due": "অগ্রিম বাকি", "Payment pending": "পেমেন্ট বাকি", "Cash on delivery": "ক্যাশ অন ডেলিভারি", "Partially paid": "আংশিক পরিশোধ",
};

export function historicalState({ status, statusLabel }: { status: string; statusLabel: string }, language: AccountLanguage) {
  return accountText(language, statusLabel, banglaStatuses[status] ?? banglaStatuses.UNKNOWN);
}

export function historicalKind(order: LegacyOrder, language: AccountLanguage) {
  return order.kind === "preorder" ? accountText(language, "Pre-order", "প্রি-অর্ডার") : accountText(language, "Order", "অর্ডার");
}

export function LegacyOrderSummary({ order, language }: { order: LegacyOrder; language: AccountLanguage }) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  return <dl>
    <div><dt>{t("Status", "অবস্থা")}</dt><dd>{historicalState(order, language)}</dd></div>
    {order.paymentLabel && <div><dt>{t("Payment", "পেমেন্ট")}</dt>
      <dd>{t(order.paymentLabel, banglaPayments[order.paymentLabel] ?? banglaStatuses.UNKNOWN)}</dd></div>}
    {order.amountMinor !== null && <div><dt>{t("Order total", "অর্ডারের মোট")}</dt>
      <dd>{customerOrderMoney(order.amountMinor, "BDT", language)} BDT</dd></div>}
  </dl>;
}

export function LegacyOrderRow({ order, href, language }: { order: LegacyOrder; href: string; language: AccountLanguage }) {
  const count = new Intl.NumberFormat(language === "bn" ? "bn-BD" : "en-BD");
  const remaining = order.items.length - 3;
  return <li className="staff-order-row commerce-panel account-order-row">
    <div className="account-order-primary">
      <span>{historicalKind(order, language)}</span>
      <Link className="staff-order-ref" href={href} prefetch={false}>{order.reference}</Link>
      <time dateTime={order.createdAt}>{customerOrderDate(new Date(order.createdAt), "bd", language)}</time>
      {order.items.length > 0 && <ul className="account-order-items">
        {order.items.slice(0, 3).map((item, index) => <li key={index}>{item.name} × {count.format(item.quantity)}</li>)}
        {remaining > 0 && <li>{accountText(language, "More items", "আরও পণ্য")} · {count.format(remaining)}</li>}
      </ul>}
    </div>
    <LegacyOrderSummary order={order} language={language} />
  </li>;
}
