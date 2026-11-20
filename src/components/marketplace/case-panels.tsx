import Link from "next/link";
import { formatMoney } from "@/config/markets";
import { marketConfiguration } from "@/lib/market-config";
import { orderHasAdapter } from "@/lib/commerce/market-commerce";
import { orderDate } from "@/lib/commerce/labels";
import { purchasedOptions } from "@/lib/commerce/purchased-options";
import { activeCaseStatuses, caseKindLabels, caseStatusLabels, mayRequestReturn } from "@/lib/marketplace/case-policy";
import { exchangeVariantsForPurchase } from "@/lib/marketplace/case-shopper";
import { casesForPurchase, casesForStaffOrder, mayOpenCancellationCase, returnItemsForPurchase, type OrderCaseDetail, type OrderCaseSummary } from "@/lib/marketplace/cases";
import { OpenOrderCase } from "./case-forms";

export function caseProgressLabel(kind: OrderCaseSummary["kind"], status: OrderCaseSummary["status"]) {
  if (kind === "EXCHANGE" && status === "RETURN_APPROVED") return "Exchange approved";
  return caseStatusLabels[status];
}

function CaseLinks({ rows, href }: { rows: OrderCaseSummary[]; href: (id: string) => string }) {
  return (
    <ul className="mp-editor-list">
      {rows.map(row => (
        <li key={row.id}>
          <Link href={href(row.id)}>{caseKindLabels[row.kind]} · {caseProgressLabel(row.kind, row.status)}</Link>
        </li>
      ))}
    </ul>
  );
}

export async function PurchaseCases({ order, shopperId }: {
  order: Parameters<typeof mayOpenCancellationCase>[0] & { id: string }; shopperId: string;
}) {
  const canStartReturn = orderHasAdapter(order, "returns", "manual") && mayRequestReturn(order);
  const [rows, returnItems] = await Promise.all([
    casesForPurchase(order.id, shopperId),
    canStartReturn ? returnItemsForPurchase(order.id, shopperId) : undefined,
  ]);
  const hasOpenCase = (kind: OrderCaseSummary["kind"]) =>
    rows.some(row => row.kind === kind && activeCaseStatuses.some(status => status === row.status));
  const returnOpen = hasOpenCase("RETURN");
  const exchangeOpen = hasOpenCase("EXCHANGE");
  const replacements = returnItems && !exchangeOpen
    ? await exchangeVariantsForPurchase(order.id, shopperId, returnItems.map(item => item.id)) : undefined;
  const requestItems = returnItems?.map(item => ({ ...item, replacements: replacements?.get(item.id) }));
  const available: OrderCaseSummary["kind"][] = [];
  if (mayOpenCancellationCase(order) && !hasOpenCase("CANCEL")) available.push("CANCEL");
  if (canStartReturn && !returnOpen && (!returnItems || returnItems.length > 0)) available.push("RETURN");
  if (requestItems?.some(item => item.replacements?.length)) available.push("EXCHANGE");
  if (!hasOpenCase("DISPUTE")) available.push("DISPUTE");

  return (
    <section className="commerce-panel">
      <h2>Manage this order</h2>
      {rows.length > 0 && <CaseLinks rows={rows} href={id => `/orders/${order.id}/cases/${id}`} />}
      {!mayRequestReturn(order) && order.status === "PLACED" && <p>Returns and exchanges open after delivery.</p>}
      {returnOpen || exchangeOpen ? <p>Track your current return or exchange above.</p> : null}
      {canStartReturn && !returnOpen && !exchangeOpen && returnItems?.length === 0 && <p>No items are available to return online. Contact GriipBuddy if you need help.</p>}
      {available.length > 0 && <OpenOrderCase orderId={order.id} available={available} returnItems={requestItems} />}
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

export function CaseHistory({ orderCase }: { orderCase: OrderCaseDetail }) {
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
