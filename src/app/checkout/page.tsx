import type { Metadata } from "next";
import { Breadcrumbs } from "@/components/store-ui";
import { CheckoutView } from "@/components/checkout-view";
import { RetailCheckout } from "@/components/retail-checkout";
import { BangladeshCheckout } from "@/components/bangladesh-checkout";
import { bangladeshCheckoutEnabled } from "@/lib/commerce/bangladesh-handoff";
import { deliveryChoices } from "@/lib/commerce/orders";
import { currentMarket } from "@/lib/market-server";
import { hybridDemoMode, marketplaceMode, orderIntakeOpen, productionMode } from "@/lib/release-config";
import { paypalCheckoutAvailability } from "@/lib/commerce/paypal-config";
import { configuredManualPayments } from "@/lib/commerce/manual-payment-config";
import { getShopper } from "@/lib/marketplace/auth";
import { catalog } from "@/lib/catalog/repository";
import type { CartCatalogItem } from "@/lib/catalog/types";
import { previewDirectCheckout } from "@/lib/commerce/checkout-market";
import { uuid } from "@/lib/commerce/checkout-types";
import { validVariantId } from "@/lib/cart/model";
import { marketStoreHref } from "@/config/regional-path";
import { savedAddresses } from "@/lib/marketplace/addresses";
import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";

export const metadata: Metadata = { title: "Guest checkout" };

type CheckoutParams = { buy?: string; quantity?: string; custom?: string; destination?: string; paypal?: string; attempt?: string; prepaid?: string };

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<CheckoutParams> }) {
  const market = await currentMarket();
  if (!market.checkout) return <div className="shell inner-page commerce-page">
    <h1 className="display-type">Checkout unavailable</h1>
    <p>Checkout is unavailable for {market.name}.</p>
    <a className="button button--outline" href={marketStoreHref("/account", market.id)}>Return to my account</a>
  </div>;
  const handoff = market.id === "bd" && bangladeshCheckoutEnabled();
  const marketplace = marketplaceMode();
  const choices = handoff ? [] : await deliveryChoices(marketplace ? "bd" : market.id);
  const manualMethods = handoff ? [] : configuredManualPayments();
  const manualChoices = manualMethods.length ? await deliveryChoices("bd", manualMethods[0].method) : [];
  const shopper = marketplace ? await getShopper() : null;
  const { buy, quantity, custom, destination, paypal, attempt, prepaid } = marketplace ? await searchParams : {};
  const prepaidAttempt = uuid.safeParse(prepaid).data;
  const personalizationIntent = custom && uuid.safeParse(custom).success ? custom : undefined;
  const count = quantity === undefined ? 1 : typeof quantity === "string" && /^\d{1,2}$/.test(quantity) ? Number(quantity) : 0;
  const validBuy = validVariantId(buy) ? buy : undefined;
  const [bdItems, usItems] = validBuy ? await Promise.all([
    catalog.resolveVariants([validBuy], "bd"), catalog.resolveVariants([validBuy], "us"),
  ]) : [[], []];
  function directSelection(item?: CartCatalogItem, alternate?: CartCatalogItem) {
    const directPreview = validBuy ? previewDirectCheckout(validBuy, count, item, alternate) : undefined;
    const directItem = item && directPreview?.reason === null ?
      { variantId: item.variantId, quantity: count } : undefined;
    return { directItem, directName: item?.name, directPersonalization: directItem && item?.personalization, personalizationIntent, directPreview };
  }
  const bangladesh = directSelection(bdItems[0], usItems[0]);
  const unitedStates = directSelection(usItems[0], bdItems[0]);
  const callback = attempt && uuid.safeParse(attempt).success && (paypal === "return" || paypal === "cancel")
    ? { action: paypal === "return" ? "capture" as const : "cancel" as const, attemptId: attempt } : undefined;
  const checkoutMarket = prepaidAttempt ? "bd" : callback || destination === "us" ? "us" : destination === "bd" ? "bd" : market.id;
  const [addresses, language] = await Promise.all([
    shopper ? savedAddresses(shopper.id, checkoutMarket) : [],
    marketplace ? currentAccountLanguage(checkoutMarket) : "en" as const,
  ]);
  const bdAddresses = addresses.flatMap(row => row.marketId === "bd" && row.details
    ? [{ id: row.id, label: row.label, isDefault: row.isDefault, value: row.details }] : []);
  const usAddresses = addresses.flatMap(row => row.marketId === "us" && row.details
    ? [{ id: row.id, label: row.label, isDefault: row.isDefault, value: row.details }] : []);
  const shopperAddress = shopper ? { name: shopper.name, email: shopper.email } : undefined;
  const demo = hybridDemoMode();
  const cod = { ...bangladesh, choices, manualChoices, manualMethods, prepaidAttempt, marketplace, addresses: bdAddresses,
    shopperAddress, demo, language, canSaveAddress: Boolean(shopper) };
  return (
    <div className="shell inner-page commerce-page">
      <Breadcrumbs items={[{ label: "Cart", href: marketStoreHref("/cart", demo ? market.id : undefined) }, { label: "Checkout" }]} />
      <div className="commerce-intro">
        <h1 className="display-type">{shopper ? "Checkout" : "Guest checkout"}</h1>
        {marketplace ? <p>Test orders only</p> : (handoff || choices.length > 0 || manualChoices.length > 0) &&
          <p>Bangladesh · {manualChoices.length ? "Cash on delivery and wallet payments" : "Cash on delivery"}{!productionMode() && " · Test orders only"}</p>}
      </div>
      {handoff ? <BangladeshCheckout /> : marketplace ? <RetailCheckout
        key={personalizationIntent ?? buy ?? attempt ?? "cart"}
        defaultDestination={checkoutMarket}
        directRequested={buy !== undefined} bangladesh={cod} unitedStates={unitedStates}
        paypal={{ ...paypalCheckoutAvailability(), callback, shopperAddress, intakeOpen: orderIntakeOpen(),
          addresses: usAddresses, canSaveAddress: Boolean(shopper) }} />
        : <CheckoutView {...cod} />}
    </div>
  );
}
