import Link from "next/link";
import { notFound } from "next/navigation";
import { store } from "@/config/store";
import { formatMoney, markets } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import { deliveryChoices } from "@/lib/commerce/orders";
import { currentMarket } from "@/lib/market-server";
import { canonicalUrl, hybridDemoMode, marketplaceMode, productionContent, productionMode } from "@/lib/release-config";
import { usesBangladeshCheckout } from "@/lib/commerce/bangladesh-handoff";
import { configuredManualPayments } from "@/lib/commerce/manual-payment-config";
import { manualPaymentLabels } from "@/lib/commerce/manual-payment-methods";
import { paypalCheckoutAvailability } from "@/lib/commerce/paypal-config";
import { usPreviewDeliveryArea } from "@/lib/commerce/us-delivery";

const existingPolicies = {
  delivery: "https://griipbuddy.com/shipping-procedure",
  returns: "https://griipbuddy.com/returns-and-exchange",
  privacy: "https://griipbuddy.com/privacy-and-policy",
  terms: "https://griipbuddy.com/terms-and-conditions",
} as const;

const titles = {
  delivery: "Delivery information",
  returns: "Cancellations, returns and refunds",
  privacy: "Privacy",
  terms: "Terms",
};
type Topic = keyof typeof titles;

export async function generateMetadata({ params }: { params: Promise<{ topic: string }> }) {
  const { topic } = await params;
  const title = titles[topic as Topic];
  return { title: title ?? "Help", alternates: title ? { canonical: canonicalUrl(`/help/${topic}`) } : undefined };
}

function Contact() {
  return <a href={`mailto:${store.supportEmail}`}>{store.supportEmail}</a>;
}

function UnitedStatesDelivery() {
  const { quoteEnabled, paymentEnabled, shippingMinor } = paypalCheckoutAvailability();
  return <>
    <section className="commerce-panel">
      <h2>United States test delivery</h2>
      <p>The preview covers {usPreviewDeliveryArea}.</p>
      {quoteEnabled && shippingMinor !== null
        ? <p>Test shipping costs {formatMoney(shippingMinor, markets.us)} per order. Review the total in US dollars before payment.</p>
        : <p>Test shipping quotes are temporarily unavailable.</p>}
      <p>Use sample contact and address details. Test orders do not book real shipments.</p>
    </section>
    <section className="commerce-panel">
      <h2>Payment and tracking</h2>
      <p>{paymentEnabled ? "Pay with a PayPal sandbox account." : quoteEnabled
        ? "You can review your order. PayPal sandbox payments are currently unavailable."
        : "Checkout is currently unavailable."}</p>
      <p>Open <Link href={marketStoreHref("/orders", "us")}>Order status</Link> for delivery updates, or use the private tracking link from a guest order.</p>
    </section>
  </>;
}

async function Delivery() {
  const firstParty = marketplaceMode();
  const selected = await currentMarket();
  const hybrid = hybridDemoMode();
  if (hybrid && selected.id === "us") return <UnitedStatesDelivery />;
  const market = firstParty ? markets.bd : selected;
  const choices = await deliveryChoices(market.id);
  const wallets = configuredManualPayments().map(({ method }) => manualPaymentLabels[method]);
  return <>
    {firstParty && <section className="commerce-panel">
      <h2>Delivery and payment by country</h2>
      <p>Enter the shipping address in checkout to see available items, delivery fees, and payment methods.</p>
      <ul className="catalog-import-results">
        <li><strong>Bangladesh</strong>
          <p>Pay in Bangladeshi taka by cash on delivery for eligible addresses.</p>
          {wallets.length > 0 && <p>Test {new Intl.ListFormat("en").format(wallets)} at checkout with a sample receipt or payer phone and transaction ID. Staff review the proof before packing.</p>}
        </li>
        <li><strong>United States</strong><p>{hybrid
          ? <a href={storefrontPath(marketStoreHref("/help/delivery", "us"))}>See US test shipping and payment options</a>
          : "Pay in US dollars with a PayPal sandbox account where checkout and delivery are available."}</p></li>
      </ul>
    </section>}
    <section className="commerce-panel">
      <h2>{firstParty ? "Bangladesh test delivery options" : `Test delivery options for ${market.name}`}</h2>
      {choices.length === 0 ? <p>Checkout is unavailable in this market.</p> : <ul className="catalog-import-results">
        {choices.map((option) => <li key={`${option.district}/${option.method}`}>
          <strong>{option.districtLabel} · {option.label}</strong> · {formatMoney(option.chargeMinor, market)}
          {option.guidance && <p>{option.guidance}</p>}
        </li>)}
      </ul>}
      <p>Check <Link href={marketStoreHref("/orders", hybrid ? selected.id : undefined)}>Order status</Link> for shipment updates and tracking details when available.</p>
    </section>
    {!firstParty && <section className="commerce-panel">
      <h2>To confirm before launch</h2>
      <p>Approved service areas, delivery fees, timing, and any failed-delivery or redelivery charges.</p>
    </section>}
  </>;
}

async function Returns() {
  if (hybridDemoMode() && (await currentMarket()).id === "us") return <>
    <section className="commerce-panel">
      <h2>Cancel a US test order</h2>
      <p>If the order has not shipped, email <Contact /> with the order reference. Support will review your request.</p>
    </section>
    <section className="commerce-panel">
      <h2>Returns and refunds</h2>
      <p>Sign in and open a delivered order in <Link href={marketStoreHref("/orders", "us")}>Purchases and reviews</Link> to request a return. For guest orders, email <Contact /> with the reference and reason.</p>
      <p>Wait for return instructions from support. Approved PayPal refunds use the original sandbox payment.</p>
    </section>
  </>;
  const firstParty = marketplaceMode();
  return <>
    <section className="commerce-panel">
      <h2>Cancellation</h2>
      <p>For an order that has not shipped, email <Contact /> with your order reference. GriipBuddy support will review the request. Check the <Link href="/orders">order status</Link> for the outcome.</p>
    </section>
    <section className="commerce-panel">
      <h2>Returns and refunds</h2>
      {firstParty
        ? <p>Open the purchase in <Link href="/orders">Order status</Link> or email <Contact /> with the order reference and reason. GriipBuddy support reviews requests and provides return instructions. Any PayPal refund in this preview is handled in the sandbox.</p>
        : <>
          <p>Email <Contact /> with the reference and reason. Staff review requests manually. A request or approval does not record money returned. There are no live payments in staging.</p>
          <p>Before launch, approve return eligibility, time limits, return instructions and address, who pays shipping, and how and when eligible COD refunds are issued.</p>
        </>}
    </section>
  </>;
}

function Privacy() {
  return <section className="commerce-panel">
    <h2>Information used in this preview</h2>
    <p>Checkout records the contact and delivery details entered, the purchased items, and order status. Authorized staff use those details to prepare the order and record delivery. A guest cookie lets the original browser open the order. The cart stays in browser storage.</p>
    {marketplaceMode() && <p>Guest shoppers can save a private link to view their items, payment status, and delivery updates on another device for seven days. The link keeps contact and address details private.</p>}
    {marketplaceMode() ? <p>Shopper accounts store a display name, an email, a password hash and session records. We save your favorites, collections, registered addresses, reviews, and messages when you use those features. A collection or registry can be made public by its owner. Product reviews are public and moderated by GriipBuddy. This preview has shopping measurement turned off.</p>
      : <p>Optional shopping measurement uses a separate random identifier and the Privacy choices at the bottom of the page. It never sends checkout contact details or guest access tokens to an analytics service. You can withdraw and delete the linked measurement without changing your order.</p>}
    <p>Use sample contact details in staging. For privacy questions, email <Contact />.</p>
    <p>Before launch, confirm the responsible legal entity and address, data recipients, retention periods, how requests for access or deletion are handled, and any production analytics or cookies.</p>
  </section>;
}

function Terms() {
  const firstParty = marketplaceMode();
  return <section className="commerce-panel">
    <h2>How test orders work</h2>
    {firstParty
      ? <p>GriipBuddy operates this development storefront. Review the item total, delivery charge, tax and amount due before placing a test order. Orders and payments here are for testing.</p>
      : <>
        <p>Guest checkout shows the item total, delivery charge, tax and amount due before you place a test COD order. It creates a record for staff to review. Staging orders do not create a charge or shipment commitment.</p>
        <p>Before launch, approve the seller’s legal details, order acceptance terms, payment and delivery terms, and the applicable dispute and cancellation provisions.</p>
      </>}
    <p>Questions about this preview can go to <Contact />.</p>
  </section>;
}

export default async function HelpPage({ params }: { params: Promise<{ topic: string }> }) {
  const { topic } = await params;
  if (!Object.hasOwn(titles, topic)) notFound();
  const title = titles[topic as Topic];
  if (productionMode()) {
    const content = productionContent()?.[topic as Topic];
    return (
      <div className="shell inner-page commerce-page customer-info">
        <div className="commerce-intro"><h1 className="display-type">{title}</h1></div>
        <section className="commerce-panel">
          {content ? content.map((paragraph, index) => <p key={index}>{paragraph}</p>)
            : usesBangladeshCheckout() ? <p><a className="text-link" href={existingPolicies[topic as Topic]}>Read the full policy on griipbuddy.com</a></p>
              : <p>This policy is pending approval.</p>}
          <p>Contact <Contact /> for assistance.</p>
        </section>
      </div>
    );
  }
  const us = hybridDemoMode() && (await currentMarket()).id === "us";
  return (
    <div className="shell inner-page commerce-page customer-info">
      <div className="commerce-intro">
        <h1 className="display-type">{title}</h1>
        <p>{us ? "United States · Test orders only" : "Draft for staging review"}</p>
      </div>
      {topic === "delivery" && <Delivery />}
      {topic === "returns" && <Returns />}
      {topic === "privacy" && <Privacy />}
      {topic === "terms" && <Terms />}
    </div>
  );
}
