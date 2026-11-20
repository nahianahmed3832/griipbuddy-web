import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { advanceOrder, cancelOrderAction, collectCashAction, refundPayPalAction } from "@/app/staff/actions";
import { BangladeshReturnReceiptPanel } from "@/components/bangladesh-return-receipt";
import { StaffBangladeshDispatchFields, StaffBangladeshTracking } from "@/components/bangladesh-shipment-staff";
import { StaffOrderCases } from "@/components/marketplace/case-panels";
import { OrderBreakdown, PurchasedItems } from "@/components/order-summary";
import { PrintPackingSlip, StaffActionForm } from "@/components/staff-actions";
import { StaffOrderParcels } from "@/components/staff-order-parcels";
import { Breadcrumbs } from "@/components/store-ui";
import { formatMoney } from "@/config/markets";
import { marketConfiguration } from "@/lib/market-config";
import { orderHasAdapter } from "@/lib/commerce/market-commerce";
import { fulfillmentLabels, orderDate, orderLabels, paymentLabels, paymentMethodLabels } from "@/lib/commerce/labels";
import { devShipmentAvailable } from "@/lib/commerce/bangladesh-shipment";
import { purchasedOptions } from "@/lib/commerce/purchased-options";
import { parcelItemsToShip } from "@/lib/commerce/parcel-tracking";
import { storeShop } from "@/lib/marketplace/constants";
import { staffSellerPreparation } from "@/lib/marketplace/seller-orders";
import { sellerPreparationLabels } from "@/lib/marketplace/seller-preparation";
import { hybridStoreMode, marketplaceMode } from "@/lib/release-config";
import { requireStaff } from "@/lib/staff/access";
import { staffOrder } from "@/lib/staff/operations";
import { staffOrderWorkspaceState } from "@/lib/staff/order-workspace-state";

export const metadata: Metadata = { title: "Staff order" };

export default async function StaffOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const [staff, { id }] = await Promise.all([requireStaff(), params]);
  const order = await staffOrder(staff.id, id);
  if (!order?.payment) notFound();

  const shopIds = [...new Set(order.items.flatMap(item =>
    item.marketplaceShopId && item.marketplaceShopId !== storeShop.id ? [item.marketplaceShopId] : [],
  ))];
  const sellerPreparation = marketplaceMode() && shopIds.length ? await staffSellerPreparation(id, shopIds) : [];

  const market = { ...marketConfiguration(order.marketId), currency: order.currency };
  const owner = staff.role === "OWNER";
  const paypal = order.payment.method === "PAYPAL";
  const refundPending = order.payment.status === "REFUND_PENDING";
  const courierTracking = hybridStoreMode() && orderHasAdapter(order, "fulfillment", "steadfast");
  const { active, awaiting, shipment, refused, parcels, hasParcels, pendingCancellation, cod, canPack, canDispatch,
    next, canCancel, fulfillment, due, requiresCodReview } = staffOrderWorkspaceState(order, order.payment);
  const itemsById = new Map(order.items.map(item => [item.id, item]));

  return (
    <>
      <div className="screen-only">
        <Breadcrumbs items={[{ label: "Orders", href: "/staff" }, { label: order.reference }]} />
        <div className="commerce-intro staff-order-heading">
          <div><h1 className="display-type">{order.reference}</h1><p>{orderDate(order.createdAt, market.id)} · {market.name} · {orderLabels[order.status]}</p></div>
          {canPack && <PrintPackingSlip />}
        </div>
        <div className="commerce-layout">
          <div className="commerce-stack">
            <section className="commerce-panel">
              <h2>Purchased items</h2>
              <PurchasedItems lines={order.items} market={market} />
            </section>
            <section className="commerce-panel">
              <h2>Delivery details</h2>
              <address>
                {order.customerName}<br />
                {order.address}<br />
                {order.locality}, {order.districtLabel}{order.postalCode && ` ${order.postalCode}`}<br />
                {order.phone}
              </address>
              {owner && order.email && <p>{order.email}</p>}
              <p>{order.deliveryLabel}</p>
              {!hasParcels && !shipment && order.carrier && <p>Manual shipment: {order.carrier} · {order.trackingReference}</p>}
            </section>
            {hasParcels ? <StaffOrderParcels orderId={id} marketId={market.id} parcels={parcels} active={active} owner={owner}
              canPrepare={canPack && !pendingCancellation && (!cod || awaiting)} canDispatch={canDispatch}
              simulate={devShipmentAvailable(order)} /> : shipment && <StaffBangladeshTracking order={order} owner={owner} />}
            {sellerPreparation.length > 0 && (
              <section className="commerce-panel">
                <h2>Seller handoff</h2>
                <ul className="staff-history">
                  {sellerPreparation.map(shop => {
                    const step = shop.fulfillments[0];
                    return <li key={shop.id}>
                      <strong>{shop.name}</strong>
                      <span>{step ? sellerPreparationLabels[step.status] : "Awaiting preparation"}</span>
                      {step && <time dateTime={step.updatedAt.toISOString()}>{orderDate(step.updatedAt, market.id)}</time>}
                    </li>;
                  })}
                </ul>
              </section>
            )}
            <section className="commerce-panel">
              <h2>Fulfillment history</h2>
              <ol className="staff-history">
                {order.events.map((event) => (
                  <li key={event.id}>
                    <strong>{event.type === "ORDER_CANCELLED" ? "Cancelled" : event.type === "ORDER_PLACED" ? "Order placed" : fulfillmentLabels[event.status]}</strong>
                    <span>{orderDate(event.createdAt, market.id)} · {event.actor?.name ?? "Guest checkout"}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
          <div className="commerce-stack">
            <section className="commerce-panel commerce-summary">
              <h2>Payment and fulfillment</h2>
              <dl>
                <div><dt>Payment method</dt><dd>{paymentMethodLabels[order.payment.method]}</dd></div>
                <div><dt>Payment status</dt><dd>{paymentLabels[order.payment.status]}</dd></div>
                {active && <div><dt>Fulfillment</dt><dd>{fulfillment}</dd></div>}
                <div className="commerce-summary__total"><dt>Amount due</dt><dd>{formatMoney(due, market)}</dd></div>
              </dl>
              {requiresCodReview && <p><strong>Manual COD review required.</strong> This order has a refused parcel and its delivery is incomplete.</p>}
              {owner && order.payment.method === "COD" && (
                <Link className="text-link" href={`/staff/cod-reconciliation/${id}`}>COD reconciliation</Link>
              )}
            </section>
            <OrderBreakdown totals={order} market={market} />
            {!hasParcels && refused && <BangladeshReturnReceiptPanel orderId={id} paymentMethod={order.payment.method} receipt={order.bangladeshRefusedParcelReceipt} />}
            {owner && marketplaceMode() && <StaffOrderCases orderId={id} staffId={staff.id} />}
            {pendingCancellation && <section className="commerce-panel">
              <h2>Shipment on hold</h2>
              <p>The shopper requested cancellation. Wait for the case decision before handing this order to the courier.</p>
              {owner && <p><Link className="text-link" href={`/staff/cases/${pendingCancellation.id}`}>Review cancellation request</Link></p>}
            </section>}
            {next && (next !== "SHIPPED" || !pendingCancellation) && (
              <section className="commerce-panel">
                <h2>Next fulfillment step</h2>
                <StaffActionForm key={next} action={advanceOrder.bind(null, id)} submitLabel={`Mark ${fulfillmentLabels[next].toLowerCase()}`}>
                  <input type="hidden" name="next" value={next} />
                  {next === "SHIPPED" && (courierTracking ? <StaffBangladeshDispatchFields order={order} /> : (
                    <>
                      <label>Carrier<input name="carrier" maxLength={60} required /></label>
                      <label>Tracking reference<input name="trackingReference" maxLength={80} required /></label>
                      <p className="commerce-muted">Shipment details are recorded manually.</p>
                    </>
                  ))}
                </StaffActionForm>
              </section>
            )}
            {owner && active && cod && awaiting && order.fulfillmentStatus === "DELIVERED" && parcels.every(parcel => parcel.status === "DELIVERED") && (
              <section className="commerce-panel">
                <h2>{courierTracking ? "Record courier cash collection" : "Record cash collection"}</h2>
                {courierTracking && <p className="commerce-muted">Confirm the amount the courier collected from the shopper. Record the courier’s remittance separately.</p>}
                <StaffActionForm action={collectCashAction.bind(null, id)} submitLabel="Record collection" secondary>
                  <label className="commerce-option"><input type="checkbox" name="confirm" value="yes" required /> {courierTracking ? "The courier confirmed the full amount was collected." : "I confirm the full amount was received."}</label>
                </StaffActionForm>
              </section>
            )}
            {owner && active && awaiting && !pendingCancellation && canCancel && (
              <section className="commerce-panel">
                <h2>Cancel order</h2>
                <StaffActionForm action={cancelOrderAction.bind(null, id)} submitLabel="Cancel order" secondary>
                  <label className="commerce-option"><input type="checkbox" name="confirm" value="yes" required /> Cancel this order and return its items to stock.</label>
                </StaffActionForm>
              </section>
            )}
            {owner && active && paypal && canCancel && (
              <section className="commerce-panel">
                <h2>{refundPending ? "PayPal refund pending" : "Cancel and refund order"}</h2>
                <StaffActionForm action={refundPayPalAction.bind(null, id)} submitLabel={refundPending ? "Check PayPal refund" : "Refund PayPal sandbox payment"} secondary>
                  <label className="commerce-option"><input type="checkbox" name="confirm" value="yes" required />
                    {refundPending ? "Check the refund with PayPal." : "Refund the full test payment and return its items to stock."}
                  </label>
                </StaffActionForm>
              </section>
            )}
          </div>
        </div>
      </div>

      {canPack && <article className="packing-slip print-only">
        <h1>GriipBuddy packing slip</h1>
        <p>{order.reference} · {orderDate(order.createdAt, market.id)}</p>
        {pendingCancellation && <p><strong>Shipment on hold while cancellation is reviewed.</strong></p>}
        <h2>Ship to</h2>
        <address>{order.customerName}<br />{order.address}<br />{order.locality}, {order.districtLabel} {order.postalCode}<br />{order.phone}</address>
        <p>{order.deliveryLabel}{!hasParcels && order.carrier && ` · ${order.carrier} · ${order.trackingReference}`}</p>
        {hasParcels ? parcels.map((parcel, index) => <section key={parcel.id}>
          <h2>Parcel {index + 1} · {parcel.locationName}</h2>
          {parcel.trackingReference && <p>{parcel.carrier} · {parcel.trackingReference}</p>}
          <ul>{parcelItemsToShip(parcel.items).map(({ quantity, orderItem }) => <li key={orderItem.id}>
            {quantity} × {orderItem.productName} · {purchasedOptions(itemsById.get(orderItem.id) ?? orderItem)} · {orderItem.sku}
            {itemsById.get(orderItem.id)?.personalization && <p className="personalization-note">Personalization: {itemsById.get(orderItem.id)?.personalization}</p>}
          </li>)}</ul>
        </section>) : <>
          <h2>Pack these items</h2>
          <ul>{order.items.map((item) => <li key={item.id}>
          {item.quantity} × {item.productName} · {purchasedOptions(item)} · {item.sku}
          {item.personalization && <p className="personalization-note">Personalization: {item.personalization}</p>}
          </li>)}</ul>
        </>}
        {cod ? <p>{hasParcels ? "Order COD total" : "Cash on delivery due"}: {formatMoney(due, market)} {market.currency}</p>
          : <p>{paymentMethodLabels[order.payment.method]} order</p>}
      </article>}
    </>
  );
}
