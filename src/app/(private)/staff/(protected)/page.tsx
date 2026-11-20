import type { Metadata } from "next";
import Link from "next/link";
import { formatMoney, markets } from "@/config/markets";
import { requireStaff } from "@/lib/staff/access";
import { listStaffOrders, queueFilter, queueFilters } from "@/lib/staff/operations";
import { orderDate, paymentLabels } from "@/lib/commerce/labels";
import { staffQueueStatus } from "@/lib/staff/order-workspace-state";

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
          {rows.map((order) => {
            const { fulfillment, requiresCodReview, pendingCancellation } = staffQueueStatus(order);
            return (
            <li className="commerce-panel staff-order-row" key={order.id}>
              <div>
                <Link className="staff-order-ref" href={`/staff/orders/${order.id}`} prefetch={false}>{order.reference}</Link>
                <p>{orderDate(order.createdAt, order.marketId)} · {order.districtLabel} · {order._count.items} {order._count.items === 1 ? "line" : "lines"}</p>
              </div>
              <div>
                <span className="staff-status">{fulfillment}</span>
                <p>{order.payment ? paymentLabels[order.payment.status] : "Payment missing"}</p>
                {requiresCodReview && <p><strong>Manual COD review required</strong></p>}
                {pendingCancellation && <p><strong>Cancellation pending · Shipment on hold</strong></p>}
              </div>
              <strong>{formatMoney(order.totalMinor, markets[order.marketId])}</strong>
            </li>
            );
          })}
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
