import { notFound } from "next/navigation";
import { z } from "zod";
import { ShopperCaseActions } from "@/components/marketplace/case-forms";
import { CaseHistory } from "@/components/marketplace/case-panels";
import { Breadcrumbs } from "@/components/store-ui";
import { marketStoreHref } from "@/config/regional-path";
import { currentMarket } from "@/lib/market-server";
import { accountText } from "@/lib/marketplace/account-language";
import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";
import { getShopper } from "@/lib/marketplace/auth";
import { caseKindLabel, caseProgressLabel } from "@/lib/marketplace/case-language";
import { buyerOrderCase } from "@/lib/marketplace/cases";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";
import "../../../order-history.css";

export async function generateMetadata() {
  return { title: accountText(await currentAccountLanguage(), "Order case", "অর্ডার সহায়তা") };
}

export default async function BuyerCasePage({ params }: { params: Promise<{ id: string; caseId: string }> }) {
  if (!marketplaceMode()) notFound();
  const [{ id, caseId }, shopper, market] = await Promise.all([params, getShopper(), currentMarket()]);
  const uuid = z.uuid();
  if (!shopper || !uuid.safeParse(id).success || !uuid.safeParse(caseId).success) notFound();
  const orderCase = await buyerOrderCase(shopper.id, id, caseId, market.id);
  if (!orderCase) notFound();
  const language = await currentAccountLanguage(market.id);
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const label = caseKindLabel(language, orderCase.kind);
  const regionalMarket = hybridDemoMode() ? market.id : undefined;
  const orderHref = (path: string) => marketStoreHref(path, regionalMarket);

  return <div className="shell inner-page commerce-page" lang={language}>
    <Breadcrumbs items={[{ label: t("Your orders", "আপনার অর্ডার"), href: orderHref("/orders") },
      { label: orderCase.order.reference, href: orderHref("/orders/" + id) }, { label }]} />
    <div className="commerce-intro">
      <h1 className="display-type">{label}</h1>
      <p>{t("Order", "অর্ডার")} {orderCase.order.reference} · {caseProgressLabel(language, orderCase)}</p>
      {orderCase.kind === "CANCEL" && orderCase.status === "RESOLVED" && <p>{t("This order has been cancelled.", "এই অর্ডারটি বাতিল হয়েছে।")}</p>}
      <p>{t("Case reference", "অনুরোধ নম্বর")} <span className="break-all">{caseId}</span></p>
    </div>
    <div className="commerce-stack">
      <CaseHistory orderCase={orderCase} language={language} />
      <ShopperCaseActions orderCase={orderCase} market={market.id} language={language} />
    </div>
  </div>;
}
