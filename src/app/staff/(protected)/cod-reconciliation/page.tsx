import Link from "next/link";
import { notFound } from "next/navigation";
import { formatMoney, markets } from "@/config/markets";
import { bangladeshTrackingLabels } from "@/lib/commerce/bangladesh-shipment-status";
import { fulfillmentLabels } from "@/lib/commerce/labels";
import { requireStaff } from "@/lib/staff/access";
import { codReconciliationFilter, codReconciliationFilters, listCodReconciliation } from "@/lib/staff/cod-remittance";

export const metadata = { title: "Bangladesh COD reconciliation" };

export default async function CodReconciliationPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const [staff, query] = await Promise.all([requireStaff(), searchParams]);
  if (staff.role !== "OWNER") notFound();
  const filter = codReconciliationFilter(query.status);
  const page = query.page && /^\d{1,4}$/.test(query.page) ? Math.max(Number(query.page), 1) : 1;
  const { rows, hasNext } = await listCodReconciliation(staff.id, filter, page);
  const pageHref = (target: number) => `/staff/cod-reconciliation?status=${filter}&page=${target}`;

  return <>
    <div className="commerce-intro">
      <h1 className="display-type">Bangladesh COD reconciliation</h1>
      <p>Match money received from couriers to the COD collected on delivered orders.</p>
    </div>
    <nav className="staff-filters" aria-label="COD reconciliation status">
      {codReconciliationFilters.map(([id, label]) => (
        <Link key={id} href={`/staff/cod-reconciliation?status=${id}`} aria-current={id === filter ? "page" : undefined}>{label}</Link>
      ))}
    </nav>
    {rows.length === 0 ? <p className="commerce-panel">No orders match this filter.</p> : (
      <ul className="staff-orders" aria-label="Matching COD orders">
        {rows.map(order => {
          const remittance = order.codRemittances[0];
          const shipment = order.bangladeshShipment;
          const delivery = order.status === "CANCELLED" ? "Cancelled" : shipment
            ? bangladeshTrackingLabels[shipment.status] : fulfillmentLabels[order.fulfillmentStatus];
          return <li className="commerce-panel staff-order-row" key={order.id}>
            <div>
              <Link className="staff-order-ref" href={`/staff/cod-reconciliation/${order.id}`} prefetch={false}>{order.reference}</Link>
              {order.carrier && <p className="wrap-anywhere">{order.carrier} · {order.trackingReference}</p>}
            </div>
            <div>
              <span className="staff-status">{delivery}</span>
              {remittance && <p className="wrap-anywhere">{remittance.reference} · {formatMoney(remittance.netMinor, markets.bd)} net received</p>}
            </div>
            <strong>{formatMoney(order.totalMinor, markets.bd)} COD</strong>
          </li>;
        })}
      </ul>
    )}
    {(page > 1 || hasNext) && <nav className="staff-filters" aria-label="COD reconciliation pages">
      {page > 1 && <Link href={pageHref(page - 1)}>Previous</Link>}
      <span>Page {page}</span>
      {hasNext && <Link href={pageHref(page + 1)}>Next</Link>}
    </nav>}
  </>;
}
