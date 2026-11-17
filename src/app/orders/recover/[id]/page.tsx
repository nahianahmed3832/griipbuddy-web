import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OpenPrivateOrderLink } from "@/components/order-recovery";
import { uuid } from "@/lib/commerce/checkout-types";
import { orderRecoveryEnabled, orderRecoveryPaths } from "@/lib/commerce/order-recovery";
import { currentMarket } from "@/lib/market-server";
import { accountText } from "@/lib/marketplace/account-language";
import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";

export const metadata: Metadata = { title: "Open a guest order", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function OpenGuestOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!orderRecoveryEnabled() || !uuid.safeParse(id).success) notFound();
  const { id: marketId } = await currentMarket();
  const language = await currentAccountLanguage(marketId);
  return <div className="shell inner-page commerce-page" lang={language}>
    <div className="commerce-intro"><h1 className="display-type">{accountText(language, "Open a guest order", "অতিথি অর্ডার খুলুন")}</h1></div>
    <OpenPrivateOrderLink orderId={id} marketId={marketId} language={language} receipt={orderRecoveryPaths(id, marketId).receipt} />
  </div>;
}
