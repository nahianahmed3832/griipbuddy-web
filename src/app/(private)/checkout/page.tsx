import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Breadcrumbs } from "@/components/store-ui";
import type { CheckoutAddress } from "@/components/checkout-view";
import { RetailCheckout } from "@/components/retail-checkout";
import { BangladeshCheckout } from "@/components/bangladesh-checkout";
import { isMarketId, marketIds } from "@/config/markets";
import { bangladeshCheckoutEnabled } from "@/lib/commerce/bangladesh-handoff";
import { uuid } from "@/lib/commerce/checkout-types";
import { deliveryChoices } from "@/lib/commerce/orders";
import { paypalCheckoutAvailability, paypalSandboxConfig } from "@/lib/commerce/paypal-config";
import { prepaidAvailable, prepaidConfig } from "@/lib/commerce/prepaid-config";
import { currentMarket } from "@/lib/market-server";
import { isMarketSelectable, marketConfiguration } from "@/lib/market-config";
import { hybridDemoMode, marketplaceMode, orderIntakeOpen, productionMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { addressBook } from "@/lib/marketplace/address-book";
import { resolveCartCatalog } from "@/lib/cart/resolve";
import { MAX_QUANTITY, validCartOfferId, validVariantId } from "@/lib/cart/model";

export const metadata: Metadata = { title: "Guest checkout" };

type CheckoutParams = { buy?: string; offer?: string; quantity?: string; custom?: string; destination?: string; paypal?: string; attempt?: string; prepaid?: string };

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<CheckoutParams> }) {
  const market = await currentMarket();
  const marketplace = marketplaceMode();
  const { buy, offer, quantity, custom, destination, paypal: paypalReturn, attempt, prepaid } = marketplace ? await searchParams : {};
  if (isMarketId(destination) && isMarketSelectable(destination) && destination !== market.id) {
    const canonical = new URLSearchParams({ market: destination });
    for (const [key, value] of Object.entries({ buy, offer, quantity, custom, paypal: paypalReturn, attempt, prepaid })) {
      if (typeof value === "string") canonical.set(key, value);
    }
    redirect(`/checkout?${canonical}`);
  }
  const handoff = bangladeshCheckoutEnabled(market.id);
  const prepaidOpen = !handoff && prepaidAvailable(market.id);
  const [choices, prepaidChoices, shopper] = await Promise.all([
    handoff ? [] : deliveryChoices(market.id),
    prepaidOpen ? deliveryChoices(market.id, "SSLCOMMERZ") : [],
    marketplace ? getShopper() : null,
  ]);
  const paypal = paypalCheckoutAvailability(market.id);
  const prepaidAttempt = !handoff && prepaidConfig(market.id) ? uuid.safeParse(prepaid).data : undefined;
  const personalizationIntent = custom && uuid.safeParse(custom).success ? custom : undefined;
  const count = quantity === undefined ? 1 : typeof quantity === "string" && /^\d{1,2}$/.test(quantity) ? Number(quantity) : 0;
  const item = validVariantId(buy) && (offer === undefined || validCartOfferId(offer))
    ? (await resolveCartCatalog([{ variantId: buy, offerId: offer }], market))[0] : undefined;
  const directItem = item?.offer && item.offer.id === offer && count >= 1 && count <= Math.min(MAX_QUANTITY, item.offer.stock)
    ? { variantId: item.variantId, offerId: item.offer.id, quantity: count } : undefined;
  const direct = { directItem, directName: item?.name, directProductId: item?.productId,
    directPersonalization: directItem && item?.personalization, personalizationIntent };
  const callback = attempt && uuid.safeParse(attempt).success && (paypalReturn === "return" || paypalReturn === "cancel")
    ? { action: paypalReturn === "return" ? "capture" as const : "cancel" as const, attemptId: attempt } : undefined;
  const rows = shopper && !handoff ? await addressBook(shopper.id, market.id, "SHIPPING") : [];
  const addresses: CheckoutAddress[] = rows.flatMap(row => row.details ? [{
    id: row.id, label: row.label, isDefault: row.isDefault,
    value: { ...row.details, postalCode: row.details.postalCode ?? "", email: row.details.email ?? "" },
  }] : []);
  const shopperAddress = shopper ? { name: shopper.name, email: shopper.email } : undefined;
  const demo = hybridDemoMode();
  const native = { ...direct, market, addressAdapter: market.address.adapter, choices,
    prepaidChoices, prepaidAttempt, marketplace, addresses, shopperAddress, demo };
  const destinations = marketIds.filter(isMarketSelectable).map(id => {
    const config = marketConfiguration(id);
    return { id, name: config.name };
  });
  return (
    <div className="shell inner-page commerce-page">
      <Breadcrumbs items={[{ label: "Cart", href: "/cart" }, { label: "Checkout" }]} />
      <div className="commerce-intro">
        <h1 className="display-type">{shopper ? "Checkout" : "Guest checkout"}</h1>
        <p>{market.name} · {market.currency}{!productionMode() && " · Test orders only"}</p>
      </div>
      {handoff ? <BangladeshCheckout market={market} /> : <RetailCheckout
        key={`${market.id}:${personalizationIntent ?? buy ?? attempt ?? "cart"}`} market={market} destinations={destinations}
        directRequested={buy !== undefined} native={native}
        paypal={paypalSandboxConfig(market.id) ? { ...direct, ...paypal, market, callback, shopperAddress, addresses, demo, intakeOpen: orderIntakeOpen() } : undefined} />}
    </div>
  );
}
