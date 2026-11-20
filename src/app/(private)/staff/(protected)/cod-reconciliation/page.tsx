import Link from "next/link";
import { notFound } from "next/navigation";
import { formatMoney, marketIds } from "@/config/markets";
import { currentMarket } from "@/lib/market-server";
import { isMarketSelectable, marketConfiguration } from "@/lib/market-config";
import { bangladeshTrackingLabels } from "@/lib/commerce/bangladesh-shipment-status";
import { fulfillmentLabels, orderDate, paymentLabels } from "@/lib/commerce/labels";
import { parcelOrderLabel } from "@/lib/commerce/parcel-tracking";
import { requireStaff } from "@/lib/staff/access";
import { codReconciliationFilter, codReconciliationFilters, listCodReconciliation, summarizeCodReconciliation } from "@/lib/staff/cod-remittance";

export const metadata = { title: "COD reconciliation" };

export default async function CodReconciliationPage({ searchParams }: { searchParams: Promise<{ status?: string; page?: string; market?: string }> }) {
  const [staff, query, selected] = await Promise.all([requireStaff(), searchParams, currentMarket()]);
  if (staff.role !== "OWNER") notFound();
  const market = marketConfiguration(isMarketSelectable(query.market) ? query.market : selected.id);
  const money = (minor: number) => formatMoney(minor, market);
  const filter = codReconciliationFilter(query.status);
  const page = query.page && /^\d{1,4}$/.test(query.page) ? Math.max(Number(query.page), 1) : 1;
  const [{ rows, hasNext }, { delivered, collected, received }] = await Promise.all([
    listCodReconciliation(staff.id, filter, page, market.id), summarizeCodReconciliation(staff.id, market.id),
  ]);
  const pageHref = (target: number) => `/staff/cod-reconciliation?market=${market.id}&status=${filter}&page=${target}`;

  return <>
    <div className="commerce-intro">
      <h1 className="display-type">{market.name} COD reconciliation</h1>
      <p>Match money received from couriers to the COD collected on delivered orders.</p>
    </div>
    <nav className="staff-filters" aria-label="COD reconciliation markets">
      {marketIds.filter(isMarketSelectable).map(id => <Link key={id} href={`/staff/cod-reconciliation?market=${id}&status=${filter}`}
        aria-current={id === market.id ? "page" : undefined}>{marketConfiguration(id).name}</Link>)}
    </nav>
    <section className="commerce-panel commerce-summary mb-4" aria-labelledby="cod-lifetime-totals">
      <h2 id="cod-lifetime-totals">All-time COD totals</h2>
      <dl>
        <div><dt>Delivered</dt><dd>{delivered.orders} orders · {money(delivered.amountMinor)} total COD</dd></div>
        <div><dt>Cash collected from shoppers</dt><dd>{collected.orders} orders · {money(collected.amountMinor)} gross</dd></div>
        <div><dt>Money received from couriers</dt><dd>{received.orders} matched orders · {money(received.amountMinor)} net</dd></div>
      </dl>
    </section>
    <nav className="staff-filters" aria-label="COD reconciliation status">
      {codReconciliationFilters.map(([id, label]) => (
        <Link key={id} href={`/staff/cod-reconciliation?market=${market.id}&status=${id}`} aria-current={id === filter ? "page" : undefined}>{label}</Link>
      ))}
    </nav>
    {rows.length === 0 ? <p className="commerce-panel">No orders match this filter.</p> : (
      <ul className="staff-orders" aria-label="Matching COD orders">
        {rows.map(order => {
          const remittance = order.codRemittances[0];
          const shipment = order.bangladeshShipment;
          const payment = order.payment;
          const delivery = order.status === "CANCELLED" ? "Cancelled" : order.parcels.length ? parcelOrderLabel(order.parcels)
            : shipment ? bangladeshTrackingLabels[shipment.status] : fulfillmentLabels[order.fulfillmentStatus];
          return <li className="commerce-panel staff-order-row" key={order.id}>
            <div>
              <Link className="staff-order-ref" href={`/staff/cod-reconciliation/${order.id}`} prefetch={false}>{order.reference}</Link>
              {order.carrier && <p className="wrap-anywhere">{order.carrier} · {order.trackingReference}</p>}
            </div>
            <div>
              <span className="staff-status">{delivery}</span>
              {order.deliveredAt && <p><time dateTime={order.deliveredAt.toISOString()}>{orderDate(order.deliveredAt, market.id)}</time></p>}
              {payment?.status === "COLLECTED" ? <p>Cash collected · {money(payment.amountMinor)}
                {payment.collectedAt && <> · <time dateTime={payment.collectedAt.toISOString()}>{orderDate(payment.collectedAt, market.id)}</time></>}
              </p>
                : payment && <p>{order.parcelReview ? "COD needs parcel review" : paymentLabels[payment.status]}</p>}
              {remittance?.status === "MATCHED" && <p>Received from courier · {money(remittance.netMinor)} net</p>}
              {remittance?.status === "DISCREPANCY" && <p>Remittance discrepancy · {money(remittance.netMinor)} reported net</p>}
              {remittance && <p className="wrap-anywhere">{remittance.reference} · <time dateTime={remittance.createdAt.toISOString()}>{orderDate(remittance.createdAt, market.id)}</time></p>}
            </div>
            <strong>{money(order.totalMinor)} {order.parcelReview ? "original COD" : "COD"}</strong>
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
