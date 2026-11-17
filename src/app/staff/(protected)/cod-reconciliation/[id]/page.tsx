import Link from "next/link";
import { notFound } from "next/navigation";
import { saveCodRemittance } from "@/app/staff/cod-remittance-actions";
import { StaffActionForm } from "@/components/staff-actions";
import { Breadcrumbs } from "@/components/store-ui";
import { formatMoney, markets } from "@/config/markets";
import { bangladeshTrackingLabels } from "@/lib/commerce/bangladesh-shipment-status";
import { fulfillmentLabels, orderDate, paymentLabels } from "@/lib/commerce/labels";
import { requireStaff } from "@/lib/staff/access";
import { codReconciliationOrder } from "@/lib/staff/cod-remittance";

export const metadata = { title: "COD remittance" };

const taka = (minor: number) => formatMoney(minor, markets.bd);

export default async function CodRemittancePage({ params }: { params: Promise<{ id: string }> }) {
  const [staff, { id }] = await Promise.all([requireStaff(), params]);
  if (staff.role !== "OWNER") notFound();
  const order = await codReconciliationOrder(staff.id, id);
  if (!order) notFound();
  const { payment, bangladeshShipment, codRemittances } = order;
  const latest = codRemittances[0];
  const delivery = order.status === "CANCELLED" ? "Cancelled" : bangladeshShipment
    ? bangladeshTrackingLabels[bangladeshShipment.status] : fulfillmentLabels[order.fulfillmentStatus];
  const reconciliation = latest?.status === "MATCHED" ? "Matched" : latest ? "Discrepancy"
    : payment.status === "VOIDED" ? "Voided"
      : !order.eligible ? "Awaiting delivery" : payment.status === "COLLECTED" ? "Awaiting remittance" : "Awaiting collection";

  return <>
    <Breadcrumbs items={[{ label: "COD reconciliation", href: "/staff/cod-reconciliation" }, { label: order.reference }]} />
    <div className="commerce-intro staff-order-heading">
      <div><h1 className="display-type">{order.reference}</h1><p>Bangladesh COD remittance</p></div>
      <Link className="button button--outline" href={`/staff/orders/${id}`}>View order</Link>
    </div>
    <div className="commerce-layout">
      <div className="commerce-stack">
        {order.canRecord && <section className="commerce-panel">
          <h2>{latest ? "Record corrected remittance" : "Record courier remittance"}</h2>
          <StaffActionForm action={saveCodRemittance.bind(null, id)} submitLabel="Record remittance">
            <label>Courier remittance reference<input name="reference" maxLength={80} required /></label>
            <label>Gross cash collected (BDT)<input name="gross" inputMode="decimal" maxLength={11} required /></label>
            <label>Courier deductions (BDT)<input name="deductions" inputMode="decimal" maxLength={11} defaultValue="0" required /></label>
            <label>Net amount received (BDT)<input name="net" inputMode="decimal" maxLength={11} required /></label>
            <label className="commerce-option"><input type="checkbox" name="confirm" value="yes" required /> I verified the reference, deductions and amount received against the courier remittance.</label>
          </StaffActionForm>
        </section>}
        {order.eligible && payment.amountMinor !== order.totalMinor && <p className="commerce-panel">The COD payment amount differs from the order total. Review it before recording remittance.</p>}
        {codRemittances.map(record => (
          <section className="commerce-panel commerce-summary" key={record.attempt}>
            <h2>{record.status === "MATCHED" ? "Matched remittance" : "Remittance discrepancy"}</h2>
            <p>{orderDate(record.createdAt)}{record.actor && ` · ${record.actor.name}`}</p>
            <dl>
              <div><dt>Reference</dt><dd className="wrap-anywhere">{record.reference}</dd></div>
              <div><dt>Expected gross</dt><dd>{taka(record.expectedGrossMinor)}</dd></div>
              <div><dt>Reported gross</dt><dd>{taka(record.grossMinor)}</dd></div>
              <div><dt>Courier deductions</dt><dd>{taka(record.deductionsMinor)}</dd></div>
              <div><dt>Net received</dt><dd>{taka(record.netMinor)}</dd></div>
              {record.status === "DISCREPANCY" && <>
                <div><dt>Gross difference</dt><dd>{taka(record.grossMinor - record.expectedGrossMinor)}</dd></div>
                <div><dt>Net difference vs. reported gross less deductions</dt><dd>{taka(record.netMinor - (record.grossMinor - record.deductionsMinor))}</dd></div>
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
          {order.carrier && <div><dt>Shipment</dt><dd className="wrap-anywhere">{order.carrier} · {order.trackingReference}</dd></div>}
          <div><dt>Cash collection</dt><dd>{paymentLabels[payment.status]}</dd></div>
          {payment.collectedAt && <div><dt>Collection recorded</dt><dd>{orderDate(payment.collectedAt)}</dd></div>}
          <div><dt>Reconciliation</dt><dd>{reconciliation}</dd></div>
          <div className="commerce-summary__total"><dt>Expected COD</dt><dd>{taka(payment.amountMinor)}</dd></div>
        </dl>
        {order.eligible && payment.status === "AWAITING_COLLECTION" && <p>Open the order to record collection.</p>}
      </section>
    </div>
  </>;
}
