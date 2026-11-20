import type { Metadata } from "next";
import Link from "next/link";
import { formatMoney, markets } from "@/config/markets";
import { requireStaff } from "@/lib/staff/access";
import { listStaffOrders, queueFilter, queueFilters } from "@/lib/staff/operations";
import { fulfillmentLabels, orderDate, paymentLabels } from "@/lib/commerce/labels";
import { parcelOrderLabel, parcelWasRefused } from "@/lib/commerce/parcel-tracking";

export const metadata: Metadata = { title: "Staff orders" };

export default async function StaffOrders({ searchParams }: { searchParams: Promise<{ status?: string; page?: string }> }) {
  const [staff, params] = await Promise.all([requireStaff(), searchParams]);
  const filter = queueFilter(params.status);
  const page = params.page && /^\d{1,4}$/.test(params.page) ? Math.max(Number(params.page), 1) : 1;
  const { rows, hasNext } = await listStaffOrders(staff.id, filter, page);
  const pageHref = (target: number) => `/staff?status=${filter}&page=${target}`;

  return (
    <>
      <div className="commerce-intro">
        <h1 className="display-type">{filter === "queue" ? "Packing queue" : "Orders"}</h1>
        <p>{filter === "queue" ? "Orders to prepare and hand off for shipping." : "Review orders by their current status."}</p>
      </div>
      <nav className="staff-filters" aria-label="Order status">
        {queueFilters.map(([id, label]) => <Link key={id} href={`/staff?status=${id}`} aria-current={filter === id ? "page" : undefined}>{label}</Link>)}
      </nav>
      {rows.length === 0 ? <p className="commerce-panel">No orders match this filter.</p> : (
        <ul className="staff-orders" aria-label="Matching orders">
          {rows.map((order) => (
            <li className="commerce-panel staff-order-row" key={order.id}>
              <div>
                <Link className="staff-order-ref" href={`/staff/orders/${order.id}`} prefetch={false}>{order.reference}</Link>
                <p>{orderDate(order.createdAt, order.marketId)} · {order.districtLabel} · {order._count.items} {order._count.items === 1 ? "line" : "lines"}</p>
              </div>
              <div>
                <span className="staff-status">{order.status === "CANCELLED" ? "Cancelled"
                  : order.parcels.some(parcel => parcel.status !== "PLANNED") ? parcelOrderLabel(order.parcels)
                  : order.bangladeshRefusedParcelReceipt ? "Refused · received at warehouse"
                  : order.bangladeshShipment?.status === "REFUSED" ? "Refused · awaiting warehouse return"
                  : order.bangladeshShipment?.status === "OUT_FOR_DELIVERY" ? "Out for delivery"
                  : fulfillmentLabels[order.fulfillmentStatus]}</span>
                <p>{order.payment ? paymentLabels[order.payment.status] : "Payment missing"}</p>
                {order.payment?.status === "AWAITING_COLLECTION" && order.parcels.some(parcelWasRefused) && <p><strong>Manual COD review required</strong></p>}
                {order.cases.length > 0 && <p><strong>Cancellation pending · Shipment on hold</strong></p>}
              </div>
              <strong>{formatMoney(order.totalMinor, markets[order.marketId])}</strong>
            </li>
          ))}
        </ul>
      )}
      {(page > 1 || hasNext) && (
        <nav className="staff-filters" aria-label="Order pages">
          {page > 1 && <Link href={pageHref(page - 1)}>Previous</Link>}
          <span>Page {page}</span>
          {hasNext && <Link href={pageHref(page + 1)}>Next</Link>}
        </nav>
      )}
    </>
  );
}
