import Link from "next/link";
import { notFound } from "next/navigation";
import { store } from "@/config/store";
import { formatMoney } from "@/config/markets";
import { deliveryChoices } from "@/lib/commerce/orders";
import { currentMarket } from "@/lib/market-server";
import { canonicalUrl, marketplaceMode, productionContent, productionMode } from "@/lib/release-config";
import { bangladeshCheckoutEnabled, usesBangladeshCheckout } from "@/lib/commerce/bangladesh-handoff";
import { paypalCheckoutAvailability } from "@/lib/commerce/paypal-config";

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

async function Delivery() {
  const market = await currentMarket();
  const [cod, prepaid] = await Promise.all([deliveryChoices(market.id, "COD"), deliveryChoices(market.id, "SSLCOMMERZ")]);
  const paypal = paypalCheckoutAvailability(market.id);
  const listing = new Map([...cod, ...prepaid].map(option => [`${option.district}/${option.method}`, option]));
  return <>
    <section className="commerce-panel">
      <h2>Delivery options for {market.name}</h2>
      {market.status === "staging" && <p>These options are for test orders.</p>}
      {paypal.quoteEnabled && <p>Checkout calculates a sandbox quote for eligible destinations. {paypal.paymentEnabled
        ? "Use a sandbox account to test payment." : "Payment credentials are pending."}</p>}
      {bangladeshCheckoutEnabled(market.id) && <p>Review the available delivery and payment options with the configured checkout provider.</p>}
      {!listing.size && !paypal.quoteEnabled && !bangladeshCheckoutEnabled(market.id) && <p>Checkout is unavailable in this market.</p>}
      {listing.size > 0 && <ul className="catalog-import-results">
        {[...listing].map(([key, option]) => <li key={key}>
          <strong>{option.districtLabel} · {option.label}</strong> · {formatMoney(option.chargeMinor, market)}
          {option.guidance && <p>{option.guidance}</p>}
        </li>)}
      </ul>}
      <p>Check <Link href="/orders">Order status</Link> for shipment updates and tracking details when available.</p>
    </section>
    {!marketplaceMode() && <section className="commerce-panel">
      <h2>To confirm before launch</h2>
      <p>Approved service areas, delivery fees, timing, and any failed-delivery or redelivery charges.</p>
    </section>}
  </>;
}

function Returns() {
  const marketplace = marketplaceMode();
  return <>
    <section className="commerce-panel">
      <h2>Cancellation</h2>
      {marketplace && <p>Sign in and open <Link href="/orders">Order status</Link> to view cancellation options for your order. To save a guest order to your account, start from the original checkout browser.</p>}
      <p>{marketplace ? "If the cancellation option is unavailable, email " : "For an order that has not shipped, email "}<Contact /> with your order reference. GriipBuddy support will review the request.</p>
    </section>
    <section className="commerce-panel">
      <h2>{marketplace ? "Returns, exchanges and refunds" : "Returns and refunds"}</h2>
      {marketplace
        ? <>
          <p>After delivery, open <Link href="/orders">Order status</Link> to view return options for your order. Choose Exchange when an eligible size or color is available.</p>
          <p>Follow pickup instructions, inspection results and refund approval or replacement tracking from your request. Contact <Contact /> if you need help.</p>
        </>
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
    {marketplaceMode() && <p>Shopper accounts store a display name, an email, a password hash and session records. We save your favorites, collections, registered addresses, reviews, and messages when you use those features. A collection or registry can be made public by its owner. Product reviews are public and moderated by GriipBuddy.</p>}
    <p>When available, Privacy choices at the bottom of the page lets you control optional shopping measurement and replay.</p>
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
    const market = await currentMarket();
    const content = productionContent()?.[topic as Topic];
    return (
      <div className="shell inner-page commerce-page customer-info">
        <div className="commerce-intro"><h1 className="display-type">{title}</h1></div>
        <section className="commerce-panel">
          {content ? content.map((paragraph, index) => <p key={index}>{paragraph}</p>)
            : usesBangladeshCheckout(market.id) ? <p><a className="text-link" href={existingPolicies[topic as Topic]}>Read the full policy on griipbuddy.com</a></p>
              : <p>This policy is pending approval.</p>}
          <p>Contact <Contact /> for assistance.</p>
        </section>
      </div>
    );
  }
  return (
    <div className="shell inner-page commerce-page customer-info">
      <div className="commerce-intro">
        <h1 className="display-type">{title}</h1>
        <p>Draft for staging review</p>
      </div>
      {topic === "delivery" && <Delivery />}
      {topic === "returns" && <Returns />}
      {topic === "privacy" && <Privacy />}
      {topic === "terms" && <Terms />}
    </div>
  );
}
