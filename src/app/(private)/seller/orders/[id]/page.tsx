import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, Download } from "lucide-react";
import { SellerPreparationForm } from "@/components/marketplace/seller-preparation-form";
import { SellerEmpty, SellerPageHeader, SellerStatus } from "@/components/marketplace/seller-ui";
import { SignInGate } from "@/components/marketplace/session";
import { formatMoney } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { fulfillmentLabels, orderDate, orderLabels, paymentLabels, paymentMethodLabels } from "@/lib/commerce/labels";
import { orderParcelStatusLabels } from "@/lib/commerce/parcel-tracking";
import { currentMarket } from "@/lib/market-server";
import { sellerOrderDetail, sellerOrderWorkspace } from "@/lib/marketplace/seller-orders";
import { sellerOrderRange } from "@/lib/marketplace/seller-order-range";
import { nextSellerPreparation, sellerPaymentAllowsPreparation, sellerPreparationLabels } from "@/lib/marketplace/seller-preparation";
import { sellerWorkspace } from "@/lib/marketplace/seller-workspace";

export const metadata = { title: "Seller order details" };

export default async function SellerOrderDetails({ params, searchParams }: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ market?: string | string[]; from?: string | string[]; to?: string | string[]; page?: string | string[]; shop?: string | string[] }>;
}) {
  const { shopper } = await sellerWorkspace();
  if (!shopper) return <div className="seller-entry">
    <SellerPageHeader title="Seller order details" />
    <SignInGate>Sign in to see your shop’s order details.</SignInGate>
  </div>;
  const [{ id }, query, market] = await Promise.all([params, searchParams, currentMarket()]);
  if (query.market !== undefined && query.market !== market.id || Array.isArray(query.shop)) notFound();
  const shop = await sellerOrderWorkspace(shopper.id, market.id, query.shop);
  if (!shop) redirect("/seller");
  const order = await sellerOrderDetail(shop.id, id, market.id);
  if (!order) notFound();

  const returnQuery = new URLSearchParams({ market: market.id, ...(!shop.owner && { shop: shop.id }) });
  const range = sellerOrderRange(query.from, query.to, new Date(), market.id);
  if (range && (query.from || query.to)) {
    returnQuery.set("from", range.from);
    returnQuery.set("to", range.to);
  }
  if (typeof query.page === "string" && /^\d{1,8}$/u.test(query.page)) returnQuery.set("page", query.page);
  const preparation = order.sellerFulfillments[0];
  const payment = order.payment?.currency === market.currency ? order.payment : null;
  const next = shop.canPrepare && sellerPaymentAllowsPreparation(payment)
    ? nextSellerPreparation(order.status, order.fulfillmentStatus, preparation?.status ?? null,
      order.parcels.some(parcel => parcel.status === "PLANNED"))
    : null;
  const subtotal = order.items.reduce((amount, line) => amount + line.lineTotalMinor, 0);
  const detailLabels = [
    ["Order", orderLabels[order.status]],
    ["Payment", payment ? paymentLabels[payment.status] : "Unavailable"],
    ["Fulfillment", order.status === "CANCELLED" ? "Cancelled" : fulfillmentLabels[order.fulfillmentStatus]],
    ...(shop.finance ? [
      ["Payment method", payment ? paymentMethodLabels[payment.method] : "Unavailable"],
      ["Your merchandise subtotal", `${formatMoney(subtotal, market)} ${market.currency}`],
    ] : []),
    ["Shop preparation", preparation ? sellerPreparationLabels[preparation.status] : "Awaiting preparation"],
  ];

  return <>
    <SellerPageHeader title={order.reference} description={`${market.name} · ${market.currency} · ${orderDate(order.createdAt, market.id)}`}
      actions={<>
        <Link className="seller-button" prefetch={false} href={`/seller/orders?${returnQuery}`}>
          <ArrowLeft size={15} aria-hidden="true"/> Back to orders
        </Link>
        {shop.finance && <a className="seller-button" href={storefrontPath(`/api/marketplace/seller/orders/${order.id}/invoice?${returnQuery}`)} download>
          <Download size={15} aria-hidden="true"/> Download shop invoice
        </a>}
        {shop.owner && <Link className="seller-button" href={`/seller/cases?${new URLSearchParams({ market: market.id, q: order.reference, state: "all" })}`}
          prefetch={false}>Requests for this order</Link>}
      </>}/>
    <section className="seller-panel" aria-label="Order status and amounts">
      <dl className="seller-facts">{detailLabels.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {preparation && <p className="seller-muted">Shop preparation updated {orderDate(preparation.updatedAt, market.id)}.</p>}
      {next && <SellerPreparationForm orderId={order.id} marketId={order.marketId} shopId={shop.managed ? shop.id : undefined} next={next} />}
    </section>
    <div className="seller-grid">
      <section className="seller-panel">
        <div className="seller-panel-heading"><h2>Your order items</h2></div>
        <ul className="seller-detail-lines">{order.items.map(line => <li key={line.id}>
          <strong>{line.quantity} × {line.productName}</strong>
          <p className="seller-muted">{line.variantName} · {line.sku}</p>
          {shop.finance && <p>{formatMoney(line.lineTotalMinor, market)} {market.currency}</p>}
          {line.personalization && <p>Personalization: {line.personalization}</p>}
        </li>)}</ul>
      </section>
      <section className="seller-panel">
        <div className="seller-panel-heading"><h2>Parcels for your shop</h2></div>
        {order.parcels.length ? <ul className="seller-detail-lines">
          {order.parcels.map(parcel => <li key={parcel.id}>
            <div className="seller-panel-heading"><strong>{parcel.locationName}</strong>
              <SellerStatus tone={parcel.status === "DELIVERED" ? "positive" : "muted"}>
                {order.status === "CANCELLED" ? "Cancelled" : orderParcelStatusLabels[parcel.status]}
              </SellerStatus></div>
            {parcel.carrier && <p><strong>Carrier</strong> · {parcel.carrier}</p>}
            {parcel.trackingReference && <p><strong>Tracking reference</strong> · {parcel.trackingReference}</p>}
            <ul>{parcel.items.map(({ orderItem, quantity }) =>
              <li key={orderItem.id}>{quantity} × {orderItem.productName} · {orderItem.variantName}</li>)}</ul>
          </li>)}
        </ul> : <SellerEmpty title="No parcel assigned">Carrier and tracking information appears after dispatch is arranged.</SellerEmpty>}
      </section>
    </div>
  </>;
}
