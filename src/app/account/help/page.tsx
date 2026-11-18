import Link from "next/link";
import { notFound } from "next/navigation";
import { AccountFrame } from "@/components/marketplace/account-frame";
import { SignInGate } from "@/components/marketplace/session";
import { marketStoreHref } from "@/config/regional-path";
import { store } from "@/config/store";
import { customerOrderDate } from "@/lib/commerce/account-order";
import { currentMarket } from "@/lib/market-server";
import { accountText } from "@/lib/marketplace/account-language";
import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";
import { getShopper } from "@/lib/marketplace/auth";
import { caseKindLabel, caseProgressLabel } from "@/lib/marketplace/case-language";
import { casesForShopper } from "@/lib/marketplace/cases";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";

export const metadata = { title: "Help and returns", robots: { index: false, follow: false } };

export default async function AccountHelp() {
  if (!marketplaceMode()) notFound();
  const [market, language, shopper] = await Promise.all([currentMarket(), currentAccountLanguage(), getShopper()]);
  const hybrid = hybridDemoMode();
  const href = (path: string) => marketStoreHref(path, hybrid ? market.id : undefined);
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const cases = shopper ? await casesForShopper(shopper.id, market.id) : [];
  return <AccountFrame market={market.id} hybrid={hybrid} language={language} section="help">
    <section className="commerce-panel">
      <h2>{t("Get help with an order", "অর্ডারের জন্য সহায়তা নিন")}</h2>
      <p>{t("Open the order to select an item and see the available actions.", "পণ্য নির্বাচন ও কী কী করা যাবে জানতে অর্ডারটি খুলুন।")}</p>
      <Link className="button button--primary" href={href("/orders")}>{t("Choose an order", "অর্ডার বেছে নিন")}</Link>
      <p>{t("For a guest order, include the order number when you contact support.", "অ্যাকাউন্ট ছাড়া করা অর্ডারের জন্য যোগাযোগের সময় অর্ডার নম্বর দিন।")}{" "}
        <a href={`mailto:${store.supportEmail}`}>{store.supportEmail}</a></p>
    </section>
    {!shopper ? <SignInGate language={language}>{t("Sign in to see your support requests.", "সহায়তার অনুরোধ দেখতে সাইন ইন করুন।")}</SignInGate> :
      <section className="commerce-panel">
        <h2>{t("My support requests", "আমার সহায়তার অনুরোধ")}</h2>
        {!cases.length ? <p>{t("There are no requests for this country yet.", "এই দেশে এখনো কোনো অনুরোধ নেই।")}</p> :
          <ul className="customer-account__stack customer-account__activity">{cases.map(item => <li key={item.id}>
            <Link href={href(`/orders/${item.order.id}/cases/${item.id}`)}>{t("Request for order", "অর্ডারের জন্য অনুরোধ")} {item.order.reference}</Link>
            <span>{caseKindLabel(language, item.kind)} · {caseProgressLabel(language, item)}</span><time dateTime={item.updatedAt.toISOString()}>
              {customerOrderDate(item.updatedAt, market.id, language)}</time>
          </li>)}</ul>}
      </section>}
  </AccountFrame>;
}
