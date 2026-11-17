import type { Metadata } from "next";
import { PendingCheckout } from "@/components/pending-checkout";
import { CartView } from "@/components/cart-view";
import { Breadcrumbs } from "@/components/store-ui";
import { deliveryChoices } from "@/lib/commerce/orders";
import { bangladeshCheckoutEnabled } from "@/lib/commerce/bangladesh-handoff";
import { currentMarket } from "@/lib/market-server";
import { marketplaceMode, orderIntakeOpen, productionMode } from "@/lib/release-config";

export const metadata: Metadata = { title: "Your cart" };

export default async function CartPage() {
  const market = await currentMarket();
  const marketplace = marketplaceMode();
  const checkoutEnabled = Boolean(market.checkout) && (marketplace ? orderIntakeOpen() :
    (market.id === "bd" && bangladeshCheckoutEnabled()) || (await deliveryChoices(market.id)).length > 0);
  return (
    <div className="shell inner-page">
      <Breadcrumbs items={[{ label: "Cart" }]} />
      <div className="page-intro">
        <p className="eyebrow">Your selections</p>
        <h1 className="display-type">Your cart</h1>
        <p>Shopping in {market.name} · {market.currency}</p>
      </div>
      <PendingCheckout />
      <CartView checkoutEnabled={checkoutEnabled} production={productionMode()} marketplace={marketplace} />
    </div>
  );
}
