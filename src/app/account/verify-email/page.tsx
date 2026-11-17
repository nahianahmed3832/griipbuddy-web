import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";
import { accountText } from "@/lib/marketplace/account-language";
import { notFound } from "next/navigation";
import { EmailAccessPanel } from "@/components/marketplace/email-access";
import { shopperMailAvailable, shopperMailPreview } from "@/lib/commerce/shopper-mail";
import { currentMarket } from "@/lib/market-server";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";

export const metadata = { title: "Verify email", robots: { index: false, follow: false }, referrer: "no-referrer" };

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ language?: string }> }) {
  if (!marketplaceMode() || !shopperMailAvailable()) notFound();
  const market = await currentMarket();
  const language = market.id === "bd" && (await searchParams).language === "bn" ? "bn" : await currentAccountLanguage(market.id);
  return <div lang={language} className="shell mp-page">
    <h1 className="mp-page-title">{accountText(language, "Verify email", "ইমেইল যাচাই করুন")}</h1>
    <section className="mp-section">
      <EmailAccessPanel kind="verification" region={market.id} language={language} hybrid={hybridDemoMode()} preview={shopperMailPreview()} />
    </section>
  </div>;
}
