import { CircleHelp, Package, Search } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountFrame, GuestAccountLanguage } from "@/components/marketplace/account-frame";
import { SignInGate } from "@/components/marketplace/session";
import { marketStoreHref } from "@/config/regional-path";
import { cashDueOnDelivery, customerOrderMoney, customerOrderStatus } from "@/lib/commerce/account-order";
import { currentMarket } from "@/lib/market-server";
import { accountInitials, accountText } from "@/lib/marketplace/account-language";
import { currentAccountLanguage, marketAccountProfile } from "@/lib/marketplace/account-language-server";
import { getShopper } from "@/lib/marketplace/auth";
import { bdOrderHubConfig } from "@/lib/marketplace/bd-order-hub-bridge";
import { caseStatusLabel } from "@/lib/marketplace/case-language";
import { casesForShopper } from "@/lib/marketplace/cases";
import { latestShopperOrder } from "@/lib/marketplace/data";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";

export const metadata = { title: "My account", robots: { index: false, follow: false } };

export default async function AccountPage() {
  if (!marketplaceMode()) notFound();
  const [market, shopper, language] = await Promise.all([currentMarket(), getShopper(), currentAccountLanguage()]);
  const hybrid = hybridDemoMode();
  const hub = market.id === "bd" && Boolean(bdOrderHubConfig());
  const href = (path: string) => marketStoreHref(path, hybrid ? market.id : undefined);
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const [order, cases, profile] = shopper ? await Promise.all([
    latestShopperOrder(shopper.id, market.id), casesForShopper(shopper.id, market.id), marketAccountProfile(shopper.id, market.id),
  ]) : [null, [], null] as const;
  const openCase = cases.find(item => !["RESOLVED", "DECLINED", "WITHDRAWN"].includes(item.status));
  const due = order ? cashDueOnDelivery(order) : null;
  const name = profile?.displayName ?? shopper?.name;

  return <AccountFrame market={market.id} hybrid={hybrid} language={language} section="home">
    {!shopper ? <>
      <SignInGate language={language}>{t("Sign in to manage orders and delivery addresses.", "অর্ডার ও ডেলিভারির ঠিকানা পরিচালনা করতে সাইন ইন করুন।")}</SignInGate>
      <GuestAccountLanguage market={market.id} language={language} />
    </> : <>
      {name && <section className="commerce-panel customer-account__welcome">
        <span aria-hidden="true">{accountInitials(name)}</span>
        <div>
          <h2>{t("Welcome,", "স্বাগতম,")} {name}</h2>
          <Link href={href("/account/settings")}>{t("Edit profile", "প্রোফাইল সম্পাদনা করুন")}</Link>
        </div>
      </section>}
      <div className="customer-account__cards">
        <section className="commerce-panel">
          <span className="customer-account__feature-icon"><Package size={22} aria-hidden="true" /></span>
          <h2>{t("My Orders", "আমার অর্ডার")}</h2>
          {order ? <>
            <p><strong>{order.reference}</strong> · {customerOrderStatus(order, language)}</p>
            {due !== null && due > 0 && <p>{t("Amount due on delivery", "পণ্য হাতে পেলে পরিশোধযোগ্য")} · <strong>{customerOrderMoney(due, order.currency, language)}</strong></p>}
            <Link href={href(`/orders/${order.id}`)}>{t("Track order", "অর্ডার ট্র্যাক করুন")}</Link>
          </> : <p>{hub ? t("View orders and pre-orders, or recover a guest purchase.", "অর্ডার ও প্রি-অর্ডার দেখুন বা অ্যাকাউন্ট ছাড়া করা অর্ডার যোগ করুন।")
            : t("View orders and delivery progress.", "অর্ডার ও ডেলিভারির অগ্রগতি দেখুন।")}</p>}
          <Link className="button button--primary" href={href("/orders")}>{t("View all orders", "সব অর্ডার দেখুন")}</Link>
        </section>
        <section className="commerce-panel">
          <span className="customer-account__feature-icon"><CircleHelp size={22} aria-hidden="true" /></span>
          <h2>{t("Help & returns", "সহায়তা ও ফেরত")}</h2>
          {openCase ? <>
            <p>{t("Order", "অর্ডার")} {openCase.order.reference} · {caseStatusLabel(language, openCase.status)}</p>
            <Link href={href(`/orders/${openCase.order.id}/cases/${openCase.id}`)}>{t("View latest update", "সর্বশেষ আপডেট দেখুন")}</Link>
          </> : <p>{t("Get help with a purchase or check progress on a support request.", "কেনাকাটায় সহায়তা নিন বা সহায়তার অনুরোধের অগ্রগতি দেখুন।")}</p>}
          <Link className="button button--outline" href={href("/account/help")}>{t("Get order help", "অর্ডারের জন্য সহায়তা নিন")}</Link>
        </section>
      </div>
    </>}
    <section className="commerce-panel">
      <span className="customer-account__feature-icon"><Search size={22} aria-hidden="true" /></span>
      <h2>{t("Find a guest order", "অ্যাকাউন্ট ছাড়া করা অর্ডার খুঁজুন")}</h2>
      <p>{hub
        ? t("Open your order confirmation link or sign in to recover an order using a verification code.", "অর্ডার নিশ্চিতকরণের লিংক খুলুন বা সাইন ইন করে যাচাইকরণ কোড দিয়ে অর্ডার যোগ করুন।")
        : t("Open the private link from your order confirmation or check orders in the browser used at checkout.", "অর্ডার নিশ্চিতকরণের ব্যক্তিগত লিংকটি খুলুন অথবা যে ব্রাউজার দিয়ে অর্ডার করেছিলেন সেখানে অর্ডার দেখুন।")}</p>
      <p><Link href={href("/orders")}>{t("Go to My Orders", "আমার অর্ডারে যান")}</Link></p>
    </section>
  </AccountFrame>;
}
