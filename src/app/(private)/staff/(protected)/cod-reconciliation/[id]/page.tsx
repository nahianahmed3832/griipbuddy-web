import Link from "next/link";
import { notFound } from "next/navigation";
import { saveCodRemittance } from "@/app/staff/cod-remittance-actions";
import { StaffActionForm } from "@/components/staff-actions";
import { Breadcrumbs } from "@/components/store-ui";
import { formatMoney } from "@/config/markets";
import { marketConfiguration } from "@/lib/market-config";
import { bangladeshTrackingLabels } from "@/lib/commerce/bangladesh-shipment-status";
import { fulfillmentLabels, orderDate, paymentLabels } from "@/lib/commerce/labels";
import { parcelOrderLabel } from "@/lib/commerce/parcel-tracking";
import { requireStaff } from "@/lib/staff/access";
import { codReconciliationOrder } from "@/lib/staff/cod-remittance";

export const metadata = { title: "COD remittance" };

export default async function CodRemittancePage({ params }: { params: Promise<{ id: string }> }) {
  const [staff, { id }] = await Promise.all([requireStaff(), params]);
  if (staff.role !== "OWNER") notFound();
  const order = await codReconciliationOrder(staff.id, id);
  if (!order) notFound();
  const market = marketConfiguration(order.marketId);
  const money = (minor: number) => formatMoney(minor, market);
  const { payment, bangladeshShipment, codRemittances } = order;
  const latest = codRemittances[0];
  const matched = codRemittances.find(record => record.status === "MATCHED");
  const delivery = order.status === "CANCELLED" ? "Cancelled" : order.parcels.length ? parcelOrderLabel(order.parcels)
    : bangladeshShipment ? bangladeshTrackingLabels[bangladeshShipment.status] : fulfillmentLabels[order.fulfillmentStatus];
  const remittanceStatus = latest ? "Discrepancy · check courier report"
    : payment.status === "VOIDED" ? "Voided"
      : order.parcelReview ? "On hold for parcel review"
        : !order.eligible ? "Awaiting delivery" : payment.status === "COLLECTED" ? "Awaiting remittance" : "Awaiting collection";

  return <>
    <Breadcrumbs items={[{ label: "COD reconciliation", href: `/staff/cod-reconciliation?market=${market.id}` }, { label: order.reference }]} />
    <div className="commerce-intro staff-order-heading">
      <div><h1 className="display-type">{order.reference}</h1><p>{market.name} COD remittance</p></div>
      <Link className="button button--outline" href={`/staff/orders/${id}`}>View order</Link>
    </div>
    <div className="commerce-layout">
      <div className="commerce-stack">
        {order.parcelReview && <section className="commerce-panel">
          <h2>Review parcel outcomes</h2>
          <p>Confirm which items arrived and what the courier collected. The original order amount is on hold.</p>
        </section>}
        {order.canRecord && <section className="commerce-panel">
          <h2>{latest ? "Record corrected remittance" : "Record courier remittance"}</h2>
          <StaffActionForm action={saveCodRemittance.bind(null, id)} submitLabel="Record remittance">
            <label>Courier remittance reference<input name="reference" maxLength={80} required /></label>
            <label>Gross cash collected ({order.currency})<input name="gross" inputMode="decimal" maxLength={11} required /></label>
            <label>Courier deductions ({order.currency})<input name="deductions" inputMode="decimal" maxLength={11} defaultValue="0" required /></label>
            <label>Net amount received ({order.currency})<input name="net" inputMode="decimal" maxLength={11} required /></label>
            <label className="commerce-option"><input type="checkbox" name="confirm" value="yes" required /> I verified the reference, deductions and amount received against the courier remittance.</label>
          </StaffActionForm>
        </section>}
        {order.eligible && payment.amountMinor !== order.totalMinor && <p className="commerce-panel">The COD payment amount differs from the order total. Review it before recording remittance.</p>}
        {codRemittances.map(record => (
          <section className="commerce-panel commerce-summary" key={record.attempt}>
            <h2>{record.status === "MATCHED" ? "Matched remittance" : "Remittance discrepancy"}</h2>
            <p>Recorded <time dateTime={record.createdAt.toISOString()}>{orderDate(record.createdAt, market.id)}</time>{record.actor && ` · ${record.actor.name}`}</p>
            <dl>
              <div><dt>Reference</dt><dd className="wrap-anywhere">{record.reference}</dd></div>
              <div><dt>Expected gross</dt><dd>{money(record.expectedGrossMinor)}</dd></div>
              <div><dt>Reported gross</dt><dd>{money(record.grossMinor)}</dd></div>
              <div><dt>Courier deductions</dt><dd>{money(record.deductionsMinor)}</dd></div>
              <div><dt>{record.status === "MATCHED" ? "Net received" : "Reported net"}</dt><dd>{money(record.netMinor)}</dd></div>
              {record.status === "DISCREPANCY" && <>
                <div><dt>Gross difference</dt><dd>{money(record.grossMinor - record.expectedGrossMinor)}</dd></div>
                <div><dt>Net difference vs. reported gross less deductions</dt><dd>{money(record.netMinor - (record.grossMinor - record.deductionsMinor))}</dd></div>
              </>}
            </dl>
          </section>
        ))}
        {codRemittances.length === 0 && !order.canRecord && <p className="commerce-panel">No remittance is recorded for this order.</p>}
      </div>
      <section className="commerce-panel commerce-summary">
        <h2>COD status</h2>
        <dl>
          <div><dt>Delivery</dt><dd>{delivery}</dd></div>
          {order.deliveredAt && <div><dt>Delivery recorded</dt><dd><time dateTime={order.deliveredAt.toISOString()}>{orderDate(order.deliveredAt, market.id)}</time></dd></div>}
          {order.carrier && <div><dt>Shipment</dt><dd className="wrap-anywhere">{order.carrier} · {order.trackingReference}</dd></div>}
          <div><dt>Cash collected from shopper</dt><dd>{payment.status === "COLLECTED" ? money(payment.amountMinor) : order.parcelReview ? "Needs review" : paymentLabels[payment.status]}</dd></div>
          {payment.collectedAt && <div><dt>Collection recorded</dt><dd><time dateTime={payment.collectedAt.toISOString()}>{orderDate(payment.collectedAt, market.id)}</time></dd></div>}
          <div><dt>Money received from courier</dt><dd>{matched ? `${money(matched.netMinor)} net matched` : remittanceStatus}</dd></div>
          {matched && <div><dt>Remittance recorded</dt><dd><time dateTime={matched.createdAt.toISOString()}>{orderDate(matched.createdAt, market.id)}</time></dd></div>}
          <div className="commerce-summary__total"><dt>{payment.status === "VOIDED" || order.parcelReview ? "Original COD" : "Expected COD"}</dt><dd>{money(payment.amountMinor)}</dd></div>
        </dl>
        {order.eligible && payment.status === "AWAITING_COLLECTION" && <p>Open the order to record collection.</p>}
      </section>
    </div>
  </>;
}
