import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountFrame, GuestAccountLanguage } from "@/components/marketplace/account-frame";
import { SignInGate } from "@/components/marketplace/session";
import { marketStoreHref } from "@/config/regional-path";
import { cashDueOnDelivery, customerOrderMoney, customerOrderStatus } from "@/lib/commerce/account-order";
import { currentMarket } from "@/lib/market-server";
import { accountText } from "@/lib/marketplace/account-language";
import { currentAccountLanguage, marketAccountProfile } from "@/lib/marketplace/account-language-server";
import { getShopper } from "@/lib/marketplace/auth";
import { caseStatusLabel } from "@/lib/marketplace/case-language";
import { casesForShopper } from "@/lib/marketplace/cases";
import { latestShopperOrder } from "@/lib/marketplace/data";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";

export const metadata = { title: "My account" };

export default async function AccountPage() {
  if (!marketplaceMode()) notFound();
  const [market, shopper, language] = await Promise.all([currentMarket(), getShopper(), currentAccountLanguage()]);
  const hybrid = hybridDemoMode();
  const href = (path: string) => marketStoreHref(path, hybrid ? market.id : undefined);
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const [order, cases, profile] = shopper ? await Promise.all([
    latestShopperOrder(shopper.id, market.id), casesForShopper(shopper.id, market.id), marketAccountProfile(shopper.id, market.id),
  ]) : [null, [], null] as const;
  const openCase = cases.find(item => !["RESOLVED", "DECLINED", "WITHDRAWN"].includes(item.status));
  const due = order ? cashDueOnDelivery(order) : null;
  return <AccountFrame market={market.id} hybrid={hybrid} language={language} section="home">
    {!shopper ? <>
      <SignInGate language={language}>{t("Sign in to manage orders and delivery addresses.", "অর্ডার ও ডেলিভারির ঠিকানা পরিচালনা করতে সাইন ইন করুন।")}</SignInGate>
      <GuestAccountLanguage market={market.id} language={language}/>
    </> : <>
      <p>{t("Welcome,", "স্বাগতম,")} {profile?.displayName ?? shopper.name}</p>
      <div className="customer-account__cards">
        <section className="commerce-panel">
          <h2>{t("Latest order", "সর্বশেষ অর্ডার")}</h2>
          {order ? <>
            <p><strong>{order.reference}</strong> · {customerOrderStatus(order, language)}</p>
            {due !== null && due > 0 && <p>{t("Amount due on delivery", "পণ্য হাতে পেলে পরিশোধযোগ্য")} · <strong>{customerOrderMoney(due, order.currency, language)}</strong></p>}
            <Link className="button button--primary" href={href(`/orders/${order.id}`)}>{t("Track order", "অর্ডার ট্র্যাক করুন")}</Link>
          </> : <><p>{t("You have no orders in this country yet.", "এই দেশে আপনার এখনো কোনো অর্ডার নেই।")}</p>
            <Link className="button button--outline" href={href("/shop")}>{t("Browse products", "পণ্য দেখুন")}</Link></>}
        </section>
        {openCase && <section className="commerce-panel">
          <h2>{t("Open support request", "চলমান সহায়তার অনুরোধ")}</h2>
          <p>{t("Order", "অর্ডার")} {openCase.order.reference} · {caseStatusLabel(language, openCase.status)}</p>
          <Link href={href(`/orders/${openCase.order.id}/cases/${openCase.id}`)}>{t("View latest update", "সর্বশেষ আপডেট দেখুন")}</Link>
        </section>}
      </div>
    </>}
    <section className="commerce-panel">
      <h2>{t("Find a guest order", "অ্যাকাউন্ট ছাড়া করা অর্ডার খুঁজুন")}</h2>
      <p>{t("Open the private link from your order confirmation or check orders in the browser used at checkout.",
        "অর্ডার নিশ্চিতকরণের ব্যক্তিগত লিংকটি খুলুন অথবা যে ব্রাউজার দিয়ে অর্ডার করেছিলেন সেখানে অর্ডার দেখুন।")}</p>
      <Link href={href("/orders")}>{t("Check this browser for an order", "এই ব্রাউজারে অর্ডার খুঁজুন")}</Link>
    </section>
  </AccountFrame>;
}
