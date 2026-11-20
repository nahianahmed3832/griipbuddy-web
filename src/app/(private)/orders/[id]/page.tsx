import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CircleCheck } from "lucide-react";
import { Breadcrumbs } from "@/components/store-ui";
import { OrderBreakdown, PurchasedItems, type ReorderOption } from "@/components/order-summary";
import { formatMoney, markets } from "@/config/markets";
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
import { resolveCartCatalog } from "@/lib/cart/resolve";
import { catalogProductHref } from "@/lib/catalog/category-browse-links";
import { reportFailure } from "@/lib/db/observability";
import { storeShop } from "@/lib/marketplace/constants";
import { ClaimOrder, OrderHelp, ReviewPurchase } from "@/components/marketplace/purchase-actions";
import { PurchaseCases } from "@/components/marketplace/case-panels";
import { BangladeshTrackingTimeline } from "@/components/bangladesh-tracking";
import { bangladeshTrackingLabels } from "@/lib/commerce/bangladesh-shipment-status";
import { OrderParcelTrackingList } from "@/components/parcel-tracking";
import { parcelOrderLabel, parcelWasRefused } from "@/lib/commerce/parcel-tracking";

export const metadata: Metadata = { title: "Your order" };

async function currentReorderOptions(items: SavedOrder["items"]): Promise<ReadonlyMap<string, ReorderOption>> {
  try {
    const market = await currentMarket();
    const references = items.map(({ id, variantId, offerIdSnapshot }) => ({
      id, variantId, offerId: offerIdSnapshot ?? undefined,
    }));
    const catalog = await resolveCartCatalog(references, market);
    const byReference = new Map(catalog.map(item => [cartOfferKey({
      variantId: item.requestedVariantId ?? item.variantId, offerId: item.requestedOfferId,
    }), item]));
    const context = { id: market.id, locale: market.locale, regional: hybridDemoMode() };
    return new Map<string, ReorderOption>(references.map(reference => {
      const item = byReference.get(cartOfferKey(reference));
      const offer = item?.offer;
      if (!item || !offer || offer.marketId !== market.id || offer.currency !== market.currency) {
        return [reference.id, { message: `This purchase is unavailable to reorder in ${market.name}.` }];
      }
      if (!offer.stock) return [reference.id, { message: `Out of stock in ${market.name}.` }];
      return [reference.id, {
        href: catalogProductHref({ slug: item.slug, matchedVariantId: item.variantId, knownOptions: [] }, context),
        currentPrice: formatMoney(offer.amountMinor, market),
      }];
    }));
  } catch (error) {
    reportFailure("order.reorder-availability", undefined, error);
    return new Map(items.map(item => [item.id, { message: "Current availability could not be checked. Refresh to try again." }]));
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
  const [reorder, [shops, reviewItems, existingReviews]] = await Promise.all([
    nativeOrder ? currentReorderOptions(nativeOrder.items) : undefined,
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
        {nativeOrder && <p><Link className="text-link" href={`/orders/${id}/invoice`}>View invoice</Link></p>}
      </div>
      <div className="commerce-layout">
        <div className="commerce-stack">
          <section className="commerce-panel">
            <h2>Purchased items</h2>
            <PurchasedItems lines={order.items} market={market} reorder={reorder} />
            {marketplace && nativeOrder?.gift && <p>Gift order{nativeOrder.giftNote && ` · ${nativeOrder.giftNote}`}</p>}
            {owned && reviewItems.map(item => <ReviewPurchase key={item.id} id={id} item={{ productId: item.id, name: item.name }}
              saved={existingReviews.find(review => review.productId === item.id)}/>)}
          </section>
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
            {parcels.length && order.status === "PLACED" ? <OrderParcelTrackingList parcels={parcels} marketId={order.marketId} />
            : shipment ? <section className="order-tracking" aria-label="Shipment tracking">
              <h3>Shipment tracking</h3>
              <BangladeshTrackingTimeline shipment={shipment} receivedAt={receivedAt} />
            </section> : order.carrier && order.trackingReference && <section className="order-tracking" aria-label="Shipment information">
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
          {owned && <PurchaseCases order={nativeOrder} shopperId={shopper.id} />}
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
          <Link className="button button--outline" href="/shop">Continue shopping</Link>
        </div>
      </div>
    </div>
  );
}
