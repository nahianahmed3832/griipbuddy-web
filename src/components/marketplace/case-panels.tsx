import Link from "next/link";
import { formatMoney } from "@/config/markets";
import { marketConfiguration } from "@/lib/market-config";
import { orderHasAdapter } from "@/lib/commerce/market-commerce";
import { orderDate } from "@/lib/commerce/labels";
import { purchasedOptions } from "@/lib/commerce/purchased-options";
import { reportFailure } from "@/lib/db/observability";
import { activeCaseStatuses, caseKindLabels, caseStatusLabels, mayRequestReturn } from "@/lib/marketplace/case-policy";
import { exchangeVariantsForPurchase } from "@/lib/marketplace/case-shopper";
import { casesForPurchase, casesForStaffOrder, mayOpenCancellationCase, returnItemsForPurchase, type OrderCaseDetail, type OrderCaseSummary } from "@/lib/marketplace/cases";
import { OpenOrderCase, RefreshOrderRequests } from "./case-forms";

export function caseProgressLabel(kind: OrderCaseSummary["kind"], status: OrderCaseSummary["status"]) {
  if (kind === "EXCHANGE" && status === "RETURN_APPROVED") return "Exchange approved";
  return caseStatusLabels[status];
}

function CaseLinks({ rows, href, customer = false }: { rows: OrderCaseSummary[]; href: (id: string) => string; customer?: boolean }) {
  return (
    <ul className={customer ? "mp-editor-list case-customer-links" : "mp-editor-list"}>
      {rows.map(row => (
        <li key={row.id}>
          <Link href={href(row.id)} prefetch={customer ? false : undefined}>
            {caseKindLabels[row.kind]} · {caseProgressLabel(row.kind, row.status)}
          </Link>
        </li>
      ))}
    </ul>
  );
}

type PurchaseCaseOrder = Parameters<typeof mayOpenCancellationCase>[0] & { id: string };

async function purchaseCaseOptions(order: PurchaseCaseOrder, shopperId: string) {
  const delivered = mayRequestReturn(order);
  const manualReturns = orderHasAdapter(order, "returns", "manual");
  const [rows, returnItems] = await Promise.all([
    casesForPurchase(order.id, shopperId),
    delivered && manualReturns ? returnItemsForPurchase(order.id, shopperId) : [],
  ]);
  const hasOpenCase = (kind: OrderCaseSummary["kind"]) =>
    rows.some(row => row.kind === kind && activeCaseStatuses.some(status => status === row.status));
  const returnOpen = hasOpenCase("RETURN");
  const exchangeOpen = hasOpenCase("EXCHANGE");
  const replacements = returnItems.length && !exchangeOpen
    ? await exchangeVariantsForPurchase(order.id, shopperId, returnItems.map(item => item.id)) : undefined;
  const requestItems = returnItems.map(item => ({ ...item, replacements: replacements?.get(item.id) }));
  const available: OrderCaseSummary["kind"][] = [];
  if (mayOpenCancellationCase(order) && !hasOpenCase("CANCEL")) available.push("CANCEL");
  if (returnItems.length && !returnOpen) available.push("RETURN");
  if (requestItems.some(item => item.replacements?.length)) available.push("EXCHANGE");
  if (!hasOpenCase("DISPUTE")) available.push("DISPUTE");
  return { delivered, manualReturns, rows, returnOpen, exchangeOpen, requestItems, available };
}

export async function PurchaseCases({ order, shopperId }: { order: PurchaseCaseOrder; shopperId: string }) {
  const options = await purchaseCaseOptions(order, shopperId).catch(error => {
    reportFailure("account.order-requests", undefined, error);
    return null;
  });
  if (!options) return <section className="commerce-panel case-order-panel" aria-labelledby="order-requests-heading">
    <h2 id="order-requests-heading">Manage this order</h2>
    <p role="alert">Order requests are temporarily unavailable.</p>
    <RefreshOrderRequests label="Check order requests" />
  </section>;

  const { delivered, manualReturns, rows, returnOpen, exchangeOpen, requestItems, available } = options;
  return (
    <section className="commerce-panel case-order-panel" aria-labelledby="order-requests-heading">
      <h2 id="order-requests-heading">Manage this order</h2>
      {rows.length > 0 ? <CaseLinks rows={rows} customer href={id => `/orders/${order.id}/cases/${id}`} />
        : <p>No requests for this order yet.</p>}
      {!delivered && order.status === "PLACED" && <p>Returns and exchanges open after delivery.</p>}
      {delivered && !manualReturns && <p>Contact <Link className="text-link" href="/help/returns">GriipBuddy support</Link> for this order’s return process.</p>}
      {returnOpen || exchangeOpen ? <p>Open your current request to track its progress.</p> : null}
      {delivered && manualReturns && !returnOpen && !exchangeOpen && requestItems.length === 0 &&
        <p>No quantities are eligible for an online return. <Link className="text-link" href="/help/returns">Get return help</Link>.</p>}
      {available.length > 0 && <OpenOrderCase orderId={order.id} available={available} returnItems={requestItems} cases={rows} />}
    </section>
  );
}

export async function StaffOrderCases({ orderId, staffId }: { orderId: string; staffId: string }) {
  const rows = await casesForStaffOrder(staffId, orderId);
  if (!rows.length) return null;
  return (
    <section className="commerce-panel">
      <h2>Order cases</h2>
      <CaseLinks rows={rows} href={id => `/staff/cases/${id}`} />
    </section>
  );
}

export function CaseHistory({ orderCase, customer = false }: { orderCase: OrderCaseDetail; customer?: boolean }) {
  const market = marketConfiguration(orderCase.order.marketId);
  return (
    <>
      {orderCase.returnLines.length > 0 && (
        <section className="commerce-panel">
          <h2>{orderCase.kind === "EXCHANGE" ? "Items in this exchange" : "Items in this return"}</h2>
          <ul className="staff-history">
            {orderCase.returnLines.map(({ orderItem, quantity, replacementVariantName }) => (
              <li key={orderItem.id}>
                <strong>{orderItem.productName} · {purchasedOptions(orderItem)} · {orderItem.sku}</strong>
                <span>Quantity: {quantity}</span>
                {replacementVariantName && <p>Replacement: {replacementVariantName}</p>}
                {orderItem.personalization && <p className="break-words">{orderItem.personalization}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {(orderCase.pickupAt || orderCase.pickupReference || orderCase.refundAmountMinor !== null || orderCase.replacementTrackingReference) && (
        <section className="commerce-panel commerce-summary">
          <h2>{orderCase.kind === "EXCHANGE" ? "Pickup and replacement" : "Pickup and refund"}</h2>
          <dl>
            {orderCase.pickupAt && <div><dt>Pickup appointment ({market.timeZone})</dt><dd>{orderDate(orderCase.pickupAt, market.id)}</dd></div>}
            {orderCase.pickupReference && <div><dt>Pickup reference</dt><dd className="break-words">{orderCase.pickupReference}</dd></div>}
            {orderCase.refundAmountMinor !== null && <div><dt>Approved refund</dt><dd>{formatMoney(orderCase.refundAmountMinor, market)}</dd></div>}
            {orderCase.replacementTrackingReference && <div><dt>Replacement tracking reference</dt><dd className="break-words">{orderCase.replacementTrackingReference}</dd></div>}
          </dl>
          {customer && orderCase.refundAmountMinor !== null &&
            <p>Refund approval is recorded here. See the order’s payment status for settlement updates.</p>}
        </section>
      )}
      <section className="commerce-panel">
        <h2>Case activity</h2>
        <ol className="staff-history">
          {orderCase.events.map(event => (
            <li key={event.revision}>
              <strong>{caseProgressLabel(orderCase.kind, event.status)}</strong>
              <span>{orderDate(event.createdAt, market.id)}</span>
              {event.note && <p className="whitespace-pre-wrap break-words">{event.note}</p>}
            </li>
          ))}
        </ol>
      </section>
    </>
  );
}
