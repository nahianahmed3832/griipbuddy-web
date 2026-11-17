import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { advanceOrder, cancelOrderAction, collectCashAction, refundPayPalAction, reviewManualPaymentAction } from "@/app/staff/actions";
import { BangladeshReturnReceiptPanel } from "@/components/bangladesh-return-receipt";
import { StaffBangladeshDispatchFields, StaffBangladeshTracking } from "@/components/bangladesh-shipment-staff";
import { StaffOrderCases } from "@/components/marketplace/case-panels";
import { OrderBreakdown, PurchasedItems } from "@/components/order-summary";
import { PrintPackingSlip, StaffActionForm } from "@/components/staff-actions";
import { Breadcrumbs } from "@/components/store-ui";
import { formatMoney, markets } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { isManualPaymentMethod } from "@/lib/commerce/manual-payment-methods";
import { canCancelFrom, fulfillmentLabels, nextFulfillment, orderDate, orderLabels, paymentLabels, paymentMethodLabels } from "@/lib/commerce/labels";
import { storeShop } from "@/lib/marketplace/constants";
import { staffSellerPreparation } from "@/lib/marketplace/seller-orders";
import { sellerPreparationLabels } from "@/lib/marketplace/seller-preparation";
import { hybridStoreMode, marketplaceMode } from "@/lib/release-config";
import { requireStaff } from "@/lib/staff/access";
import { staffManualPayment, staffOrder } from "@/lib/staff/operations";

export const metadata: Metadata = { title: "Staff order" };

export default async function StaffOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const [staff, { id }] = await Promise.all([requireStaff(), params]);
  const order = await staffOrder(staff.id, id);
  if (!order?.payment) notFound();

  const shopIds = [...new Set(order.items.flatMap(item =>
    item.marketplaceShopId && item.marketplaceShopId !== storeShop.id ? [item.marketplaceShopId] : [],
  ))];
  const sellerPreparation = marketplaceMode() && shopIds.length ? await staffSellerPreparation(id, shopIds) : [];

  const market = markets[order.marketId];
  const owner = staff.role === "OWNER";
  const active = order.status === "PLACED";
  const paypal = order.payment.method === "PAYPAL";
  const refundPending = order.payment.status === "REFUND_PENDING";
  const awaiting = order.payment.status === "AWAITING_COLLECTION";
  const verifying = order.payment.status === "AWAITING_VERIFICATION";
  const manual = isManualPaymentMethod(order.payment.method);
  const evidence = owner && manual ? await staffManualPayment(staff.id, id) : null;
  const bangladesh = order.marketId === "bd" && hybridStoreMode();
  const shipment = order.bangladeshShipment;
  const refused = shipment?.status === "REFUSED";
  const canPack = active && !refused && (order.payment.method === "COD" || order.payment.status === "PAID");
  const next = canPack && !shipment ? nextFulfillment[order.fulfillmentStatus] : undefined;
  const fulfillment = refused ? "Delivery refused" : shipment?.status === "OUT_FOR_DELIVERY"
    ? "Out for delivery" : fulfillmentLabels[order.fulfillmentStatus];
  const due = awaiting || verifying ? order.payment.amountMinor : 0;

  return (
    <>
      <div className="screen-only">
        <Breadcrumbs items={[{ label: "Orders", href: "/staff" }, { label: order.reference }]} />
        <div className="commerce-intro staff-order-heading">
          <div><h1 className="display-type">{order.reference}</h1><p>{orderDate(order.createdAt)} · {market.name} · {orderLabels[order.status]}</p></div>
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
              {!shipment && order.carrier && <p>Manual shipment: {order.carrier} · {order.trackingReference}</p>}
            </section>
            {shipment && <StaffBangladeshTracking order={order} owner={owner} />}
            {sellerPreparation.length > 0 && (
              <section className="commerce-panel">
                <h2>Seller handoff</h2>
                <ul className="staff-history">
                  {sellerPreparation.map(shop => {
                    const step = shop.fulfillments[0];
                    return <li key={shop.id}>
                      <strong>{shop.name}</strong>
                      <span>{step ? sellerPreparationLabels[step.status] : "Awaiting preparation"}</span>
                      {step && <time dateTime={step.updatedAt.toISOString()}>{orderDate(step.updatedAt)}</time>}
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
                    <span>{orderDate(event.createdAt)} · {event.actor?.name ?? "Guest checkout"}</span>
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
                <div className="commerce-summary__total"><dt>{verifying ? "Amount to verify" : "Amount due"}</dt><dd>{formatMoney(due, market)}</dd></div>
              </dl>
              {owner && bangladesh && order.payment.method === "COD" && (
                <Link className="text-link" href={`/staff/cod-reconciliation/${id}`}>COD reconciliation</Link>
              )}
            </section>
            {evidence && <section className="commerce-panel commerce-summary">
              <h2>Wallet payment evidence</h2>
              {evidence.test && <p className="commerce-muted">Test submission. Do not expect a real transfer.</p>}
              <dl>
                <div><dt>Receiving number</dt><dd>{evidence.recipient}</dd></div>
                <div><dt>Submitted</dt><dd>{orderDate(evidence.submittedAt)}</dd></div>
                {evidence.payerPhone && <div><dt>Payer phone</dt><dd>{evidence.payerPhone}</dd></div>}
                {evidence.submittedTransaction && <div><dt>Submitted transaction ID</dt><dd>{evidence.submittedTransaction}</dd></div>}
                {evidence.verifiedTransaction && <div><dt>Verified transaction ID</dt><dd>{evidence.verifiedTransaction}</dd></div>}
                {evidence.reviewedAt && <div><dt>Reviewed</dt><dd>{orderDate(evidence.reviewedAt)}</dd></div>}
                {evidence.reviewNote && <div><dt>Decline reason</dt><dd>{evidence.reviewNote}</dd></div>}
              </dl>
              {!evidence.payerPhone && <a className="text-link" href={storefrontPath(`/api/staff/orders/${id}/payment-receipt`)}>
                Download private receipt
              </a>}
              {active && verifying && <>
                <StaffActionForm action={reviewManualPaymentAction.bind(null, id, true)} submitLabel="Approve wallet payment">
                  <p className="commerce-muted">{evidence.test
                    ? "Use the sample transaction ID and order amount to exercise approval."
                    : "Check the receiving wallet ledger before approving this payment."}</p>
                  <label>Amount received (BDT)<input type="text" inputMode="decimal" name="amount" required maxLength={9} /></label>
                  <label>Verified transaction ID<input name="transaction" defaultValue={evidence.submittedTransaction ?? ""}
                    autoCapitalize="characters" required minLength={6} maxLength={32} /></label>
                  <label className="commerce-option"><input type="checkbox" name="confirm" value="yes" required />
                    {evidence.test ? "Confirm test verification." : "I verified this transfer in the receiving wallet."}</label>
                </StaffActionForm>
                <StaffActionForm action={reviewManualPaymentAction.bind(null, id, false)} submitLabel="Decline and cancel order" secondary>
                  <label>Reason for declining<textarea name="reason" required minLength={3} maxLength={300} /></label>
                  <label className="commerce-option"><input type="checkbox" name="confirm" value="yes" required />
                    Cancel the order and return its items to stock.</label>
                </StaffActionForm>
              </>}
            </section>}
            <OrderBreakdown totals={order} market={market} />
            {refused && <BangladeshReturnReceiptPanel orderId={id} paymentMethod={order.payment.method} receipt={order.bangladeshRefusedParcelReceipt} />}
            {owner && marketplaceMode() && <StaffOrderCases orderId={id} staffId={staff.id} />}
            {next && (
              <section className="commerce-panel">
                <h2>Next fulfillment step</h2>
                <StaffActionForm key={next} action={advanceOrder.bind(null, id)} submitLabel={`Mark ${fulfillmentLabels[next].toLowerCase()}`}>
                  <input type="hidden" name="next" value={next} />
                  {next === "SHIPPED" && (bangladesh ? <StaffBangladeshDispatchFields order={order} /> : (
                    <>
                      <label>Carrier<input name="carrier" maxLength={60} required /></label>
                      <label>Tracking reference<input name="trackingReference" maxLength={80} required /></label>
                      <p className="commerce-muted">Shipment details are recorded manually.</p>
                    </>
                  ))}
                </StaffActionForm>
              </section>
            )}
            {owner && active && awaiting && order.fulfillmentStatus === "DELIVERED" && (
              <section className="commerce-panel">
                <h2>{bangladesh ? "Record courier cash collection" : "Record cash collection"}</h2>
                {bangladesh && <p className="commerce-muted">Confirm the amount the courier collected from the shopper. Record the courier’s remittance separately.</p>}
                <StaffActionForm action={collectCashAction.bind(null, id)} submitLabel="Record collection" secondary>
                  <label className="commerce-option"><input type="checkbox" name="confirm" value="yes" required /> {bangladesh ? "The courier confirmed the full amount was collected." : "I confirm the full amount was received."}</label>
                </StaffActionForm>
              </section>
            )}
            {owner && active && awaiting && canCancelFrom.includes(order.fulfillmentStatus) && (
              <section className="commerce-panel">
                <h2>Cancel order</h2>
                <StaffActionForm action={cancelOrderAction.bind(null, id)} submitLabel="Cancel order" secondary>
                  <label className="commerce-option"><input type="checkbox" name="confirm" value="yes" required /> Cancel this order and return its items to stock.</label>
                </StaffActionForm>
              </section>
            )}
            {owner && active && paypal && canCancelFrom.includes(order.fulfillmentStatus) && (
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
        <p>{order.reference} · {orderDate(order.createdAt)}</p>
        <h2>Ship to</h2>
        <address>{order.customerName}<br />{order.address}<br />{order.locality}, {order.districtLabel} {order.postalCode}<br />{order.phone}</address>
        <p>{order.deliveryLabel}{order.carrier && ` · ${order.carrier} · ${order.trackingReference}`}</p>
        <h2>Pack these items</h2>
        <ul>{order.items.map((item) => <li key={item.id}>
          {item.quantity} × {item.productName} · {item.variantName} · {item.sku}
          {item.personalization && <p className="personalization-note">Personalization: {item.personalization}</p>}
        </li>)}</ul>
        {order.payment.method === "COD" ? <p>Cash on delivery due: {formatMoney(due, market)} {market.currency}</p>
          : <p>{paymentMethodLabels[order.payment.method]} · prepaid</p>}
      </article>}
    </>
  );
}
