import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CircleCheck } from "lucide-react";
import { Suspense } from "react";
import { Breadcrumbs } from "@/components/store-ui";
import { OrderBreakdown, PurchasedItems, type ReorderOption } from "@/components/order-summary";
import { OrderReorder } from "@/components/order-reorder";
import { OrderTrackingLink } from "@/components/order-tracking-link";
import { formatMoney, markets, type Market } from "@/config/markets";
import { store } from "@/config/store";
import { guestCookie, readGuestKey } from "@/lib/commerce/guest";
import { fulfillmentLabels, orderLabels, paymentLabels, paymentMethodLabels } from "@/lib/commerce/labels";
import { guestOrder, type SavedOrder } from "@/lib/commerce/orders";
import { integratedCheckout, readRecoveredOrder } from "@/lib/commerce/integrated-checkout";
import { getShopper } from "@/lib/marketplace/auth";
import { getDb } from "@/lib/db/client";
import { hybridDemoMode, marketplaceMode } from "@/lib/release-config";
import { currentMarket } from "@/lib/market-server";
import { cartOfferKey } from "@/lib/cart/model";
import { reorderCatalogByReference, type ReorderLine } from "@/lib/cart/reorder-review";
import { resolveCartCatalog } from "@/lib/cart/resolve";
import { catalogBrowseHref, catalogProductHref } from "@/lib/catalog/category-browse-links";
import { personalizationAvailable } from "@/lib/catalog/personalization";
import { reportFailure } from "@/lib/db/observability";
import { storeShop } from "@/lib/marketplace/constants";
import { ClaimOrder, OrderHelp, ReviewPurchase } from "@/components/marketplace/purchase-actions";
import { PurchaseCases } from "@/components/marketplace/case-panels";
import { bangladeshTrackingLabels } from "@/lib/commerce/bangladesh-shipment-status";
import { parcelOrderLabel, parcelWasRefused } from "@/lib/commerce/parcel-tracking";

export const metadata: Metadata = { title: "Your order", robots: { index: false, follow: false } };

async function currentReorderOptions(items: SavedOrder["items"], market: Market) {
  const options = new Map<string, ReorderOption>();
  const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
  const references = items.map(line => ({ variantId: line.variantId, offerId: line.offerIdSnapshot ?? undefined }));
  try {
    const byReference = reorderCatalogByReference(await resolveCartCatalog(references, market));
    const lines: ReorderLine[] = items.map(({ id, productName, sku, quantity, personalization, marketplaceShopId }, index) => {
      const summary = { id, productName, sku, quantity };
      const reference = references[index];
      const item = byReference.get(cartOfferKey(reference));
      const offer = item?.offer;
      const unavailable = (message: string) => {
        options.set(id, { message });
        return { ...summary, message };
      };
      if (!item || !offer || offer.marketId !== market.id || offer.currency !== market.currency) {
        return unavailable(`This purchase is unavailable to reorder in ${market.name}.`);
      }
      if (!reference.offerId && (offer.id || (item.shop?.id ?? storeShop.id) !== (marketplaceShopId ?? storeShop.id))) {
        return unavailable("The original seller’s current offer couldn’t be matched.");
      }
      if (!offer.stock) return unavailable(`Out of stock in ${market.name}.`);
      const detail = offer.stock < quantity
        ? `Only ${offer.stock} of ${quantity} available. Open the exact variant to change the quantity.`
        : undefined;
      options.set(id, {
        href: catalogProductHref({ slug: item.slug, matchedVariantId: item.variantId, knownOptions: [] }, context),
        currentPrice: formatMoney(offer.amountMinor, market), detail,
      });
      if (detail) return { ...summary, message: detail };
      if (!reference.offerId || !offer.id || !personalizationAvailable(item.personalization, personalization || undefined)) {
        return { ...summary, message: "Review the current offer or personalization on the product page." };
      }
      return { ...summary, reference, variantId: item.variantId, offerId: offer.id, amountMinor: offer.amountMinor,
        ...(personalization && { personalization }) };
    });
    return { options, lines };
  } catch (error) {
    reportFailure("order.reorder-availability", undefined, error);
    for (const { id } of items) options.set(id, { message: "Current availability could not be checked. Refresh to try again." });
    return { options, lines: [] };
  }
}

export default async function ConfirmationPage({ params }: { params: Promise<{ id: string }> }) {
  const [{ id }, jar] = await Promise.all([params, cookies()]);
  const guestKey = readGuestKey(jar.get(guestCookie)?.value);
  const marketplace = marketplaceMode();
  const shopper = marketplace ? await getShopper() : null;
  if (!guestKey && !shopper) notFound();
  const saved = guestKey && integratedCheckout() ? await readRecoveredOrder(id, guestKey) : null;
  const nativeOrder = saved ? null : await guestOrder(id, guestKey, shopper?.id);
  const order = saved ? {
    status: saved.status === "cancelled" ? "CANCELLED" as const : "PLACED" as const, reference: saved.number,
    marketId: "bd" as const, fulfillmentStatus: saved.fulfillment,
    customerName: saved.destination.name, address: saved.destination.address, locality: saved.destination.city,
    districtLabel: saved.destination.state, phone: saved.destination.phone, postalCode: saved.destination.postal,
    deliveryLabel: "Standard delivery", deliveryGuidance: null, carrier: saved.tracking ? "Recorded handoff" : null,
    trackingReference: saved.tracking,
    subtotalMinor: saved.original.merchandiseMinor, discountMinor: saved.original.discountMinor,
    deliveryMinor: saved.original.shippingMinor, taxMinor: saved.original.taxMinor, taxLabel: "Tax (trial)", totalMinor: saved.total,
    items: saved.original.lines.map(line => ({
      variantId: line.variantId, productName: line.title, variantName: Object.values(line.attributes ?? {}).join(" / "),
      sku: line.sku, quantity: line.quantity, unitPriceMinor: line.unitMinor, unitDiscountMinor: 0,
      lineTotalMinor: line.unitMinor * line.quantity - line.discountMinor,
    })),
    payment: { method: "COD" as const, status: saved.status === "cancelled" ? "VOIDED" as const :
      saved.payment === "paid" ? "COLLECTED" as const : "AWAITING_COLLECTION" as const, amountMinor: saved.total },
  } : nativeOrder;
  if (!order?.payment) notFound();

  const market = nativeOrder ? { ...markets[order.marketId], currency: nativeOrder.currency } : markets[order.marketId];
  const shipment = nativeOrder?.bangladeshShipment;
  const receivedAt = nativeOrder?.bangladeshRefusedParcelReceipt?.receivedAt;
  const parcels = nativeOrder?.parcels ?? [];
  const deliveryStatus = parcels.length ? parcelOrderLabel(parcels) : shipment
    ? receivedAt ? "Returned to GriipBuddy" : bangladeshTrackingLabels[shipment.status]
    : fulfillmentLabels[order.fulfillmentStatus];
  const codNeedsReview = order.payment.method === "COD" && order.payment.status === "AWAITING_COLLECTION" && parcels.some(parcelWasRefused);
  const amountDue = order.payment.status === "AWAITING_COLLECTION" ? order.payment.amountMinor : 0;
  const owned = marketplace && nativeOrder && shopper && nativeOrder.shopperId === shopper.id;
  const trackingHref = nativeOrder ? (owned ? `/orders/${id}/tracking` : `/orders/track/${id}`) : undefined;
  const shoppingMarket = await currentMarket();
  const shoppingContext = { id: shoppingMarket.id, locale: shoppingMarket.locale, regional: hybridDemoMode() };
  const [reorder, [shops, reviewItems, existingReviews]] = await Promise.all([
    nativeOrder ? currentReorderOptions(nativeOrder.items, shoppingMarket) : undefined,
    owned ? Promise.all([
      getDb().marketplaceShop.findMany({ where: { id: { in: [...new Set(nativeOrder.items.map(item => item.marketplaceShopId ?? storeShop.id))] }, published: true }, select: { id: true, name: true } }),
      order.fulfillmentStatus === "DELIVERED" ? getDb().product.findMany({ where: { variants: {
        some: { id: { in: nativeOrder.items.map(item => item.variantId) } },
      } }, select: { id: true, name: true } }) : [],
      getDb().shopperReview.findMany({ where: { orderId: id, shopperId: shopper.id }, select: { productId: true, text: true, stars: true, visible: true } }),
    ]) : [[], [], []],
  ]);
  return (
    <div className="shell inner-page commerce-page">
      <Breadcrumbs items={[{ label: "Your order" }]} />
      <div className="commerce-intro">
        <h1 className="display-type">
          {order.status === "PLACED" && <CircleCheck size={29} aria-hidden="true" />} {order.status === "PLACED" ? "Order confirmed" : "Order cancelled"}
        </h1>
        <p>Order reference <strong>{order.reference}</strong></p>
        {trackingHref && <p><OrderTrackingLink className="text-link" href={trackingHref}>Track order</OrderTrackingLink></p>}
        {nativeOrder && <p><Link className="text-link" href={`/orders/${id}/invoice`}>View invoice</Link></p>}
      </div>
      <div className="commerce-layout">
        <div className="commerce-stack">
          <section className="commerce-panel">
            <h2>Purchased items</h2>
            <PurchasedItems lines={order.items} market={market} reorder={reorder?.options} />
            {saved && <p className="commerce-muted">Contact support to check whether these earlier purchases can be reordered.</p>}
            {marketplace && nativeOrder?.gift && <p>Gift order{nativeOrder.giftNote && ` · ${nativeOrder.giftNote}`}</p>}
            {owned && reviewItems.map(item => <ReviewPurchase key={item.id} id={id} item={{ productId: item.id, name: item.name }}
              saved={existingReviews.find(review => review.productId === item.id)}/>)}
          </section>
          {reorder?.lines.some(line => "reference" in line) && <OrderReorder key={`${id}:${shoppingMarket.id}`} lines={reorder.lines}
            market={shoppingMarket} cartHref={catalogBrowseHref("/cart", shoppingContext)} />}
          <section className="commerce-panel">
            <h2>Delivery details</h2>
            <address>
              {order.customerName}<br />
              {order.address}<br />
              {order.locality}, {order.districtLabel}{order.postalCode && ` ${order.postalCode}`}<br />
              {order.phone}
            </address>
            <p>{order.deliveryLabel}</p>
            {order.deliveryGuidance && <p>{order.deliveryGuidance}</p>}
            {parcels.length === 0 && !shipment && order.carrier && order.trackingReference && <section className="order-tracking" aria-label="Shipment information">
              <h3>Shipment information</h3>
              <p>{order.carrier} · {order.trackingReference}</p>
              <p className="commerce-muted">Recorded by GriipBuddy staff.</p>
            </section>}
          </section>
        </div>
        <div className="commerce-stack">
          <section className="commerce-panel commerce-summary" aria-label="Payment and status">
            <h2>Payment and status</h2>
            <dl>
              <div><dt>Payment method</dt><dd>{paymentMethodLabels[order.payment.method]}</dd></div>
              <div><dt>Payment status</dt><dd>{codNeedsReview ? "COD needs review" : paymentLabels[order.payment.status]}</dd></div>
              <div><dt>Order status</dt><dd>{orderLabels[order.status]}</dd></div>
              {order.status === "PLACED" && <div><dt>Fulfillment</dt><dd>{deliveryStatus}</dd></div>}
              <div className="commerce-summary__total"><dt>Amount due</dt><dd>{codNeedsReview ? "Under review" : formatMoney(amountDue, market)}</dd></div>
            </dl>
            <form method="get">
              <button type="submit" className="button button--outline">Refresh status</button>
            </form>
          </section>
          <OrderBreakdown totals={order} market={market} />
          {owned && <Suspense fallback={<section className="commerce-panel" role="status">Loading order requests…</section>}>
            <PurchaseCases order={nativeOrder} shopperId={shopper.id} />
          </Suspense>}
          <section className="commerce-panel customer-info">
            <h2>Need help with this order?</h2>
            <p><a href={`mailto:${store.supportEmail}?subject=${encodeURIComponent(`Order ${order.reference}`)}`}>Email GriipBuddy</a> or read the <Link href="/help/returns">cancellation, return, exchange and refund information</Link>.</p>
            <p><Link href="/orders">Your recent orders</Link></p>
            {owned && <OrderHelp id={id} shops={shops}/>}
            {marketplace && nativeOrder && !nativeOrder.shopperId && <>
              {nativeOrder.marketId === "bd" && <p>Save this order to your account to request a cancellation, return, or exchange and track it here.</p>}
              <ClaimOrder id={id}/>
            </>}
          </section>
          <Link className="button button--outline" href={catalogBrowseHref("/shop", shoppingContext)}>Continue shopping</Link>
        </div>
      </div>
    </div>
  );
}
