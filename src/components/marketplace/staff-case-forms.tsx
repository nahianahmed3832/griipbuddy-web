"use client";

import { formatMoney, markets, type MarketId } from "@/config/markets";
import type { OrderCaseKind, OrderCaseStatus } from "@/generated/prisma/enums";
import { activeCaseStatuses, caseStatusLabels, ownerCaseTransitions } from "@/lib/marketplace/case-policy";
import { MarketplaceForm } from "./action-form";

type StaffCase = {
  id: string;
  revision: number;
  kind: OrderCaseKind;
  status: OrderCaseStatus;
  returnLineCount: number;
  orderCancelled: boolean;
  canApproveCancellation: boolean;
  cancellationRefundMinor: number;
  canApproveRefund: boolean;
  canConfirmRefund: boolean;
  canShipExchange: boolean;
  maxRefundMinor: number;
  refundAmountMinor: number | null;
};

function refundMinor(form: FormData) {
  return Math.round(Number(form.get("amount")) * 100);
}

export function StaffCaseActions({ orderCase, market }: { orderCase: StaffCase; market: MarketId }) {
  const endpoint = "/api/marketplace/cases?" + new URLSearchParams({ market });
  const identity = { caseId: orderCase.id, revision: orderCase.revision };
  const { kind, status, returnLineCount } = orderCase;
  const active = activeCaseStatuses.some(candidate => candidate === status);
  const receiveItems = (kind === "RETURN" || kind === "EXCHANGE") && status === "RETURN_APPROVED" && returnLineCount > 0;
  const options = ownerCaseTransitions(kind, status, returnLineCount > 0).filter(
    next => kind !== "CANCEL" || next !== "RESOLVED" || orderCase.orderCancelled,
  );
  const payoutPending = status === "REFUND_APPROVED";
  const approvedAmount = orderCase.refundAmountMinor;
  const exactRefund = approvedAmount !== null && (payoutPending || status === "REFUND_FAILED");

  return <>
    {orderCase.canApproveCancellation && <section className="commerce-panel">
      <h2>Approve cancellation</h2>
      {orderCase.cancellationRefundMinor > 0
        ? <p>Cancelling will release the stock and record a pending refund of {formatMoney(orderCase.cancellationRefundMinor, markets.bd)}.</p>
        : <p>Cancelling will void the unpaid order and release the stock.</p>}
      <MarketplaceForm endpoint={endpoint} label="Approve cancellation" success="Order cancelled."
        fields={<>
          <label>Message to shopper<textarea name="note" rows={3} minLength={3} maxLength={1500} required /></label>
          <label className="mp-remember"><input name="confirmed" type="checkbox" required /> I confirm this order should be cancelled.</label>
        </>}
        command={form => ({ action: "approve-cancellation", ...identity, note: form.get("note") })}
      />
    </section>}

    {receiveItems && <section className="commerce-panel">
      <h2>Receive returned items</h2>
      <p>Match the physical items and quantities to this case before recording the receipt.</p>
      <MarketplaceForm endpoint={endpoint} label="Record return receipt" success="Return receipt recorded."
        fields={<>
          <label>Stock decision
            <select name="disposition" required defaultValue="">
              <option value="" disabled>Choose after inspection</option>
              <option value="RESTOCK">Restock all returned items that are complete and sellable</option>
              <option value="HOLD">Hold damaged or uncertain items for review</option>
            </select>
          </label>
          <label className="mp-remember"><input name="confirmed" type="checkbox" value="yes" required /> I received and inspected every item listed in this case.</label>
        </>}
        command={form => ({ action: "receive", ...identity,
          disposition: form.get("disposition"), confirmed: form.get("confirmed") === "yes" })}
      />
    </section>}

    {orderCase.canShipExchange && <section className="commerce-panel">
      <h2>Ship replacement</h2>
      <p>Enter the replacement shipment details after handing the parcel to the carrier.</p>
      <MarketplaceForm endpoint={endpoint} label="Ship replacement" success="Replacement shipment recorded."
        fields={<>
          <label>Carrier<input name="carrier" maxLength={60} required /></label>
          <label>Tracking reference<input name="trackingReference" maxLength={80} required /></label>
          <label>Message to shopper<textarea name="note" rows={3} minLength={3} maxLength={1500} required /></label>
        </>}
        command={form => ({ action: "ship-exchange", ...identity, carrier: form.get("carrier"),
          trackingReference: form.get("trackingReference"), note: form.get("note") })}
      />
    </section>}

    {orderCase.canApproveRefund && <section className="commerce-panel">
      <h2>{status === "REFUND_FAILED" ? "Retry refund" : "Approve refund"}</h2>
      <p>Record the planned payout amount. The maximum is {formatMoney(orderCase.maxRefundMinor, markets.bd)}.</p>
      <MarketplaceForm endpoint={endpoint} label={status === "REFUND_FAILED" ? "Retry refund" : "Approve refund"} success="Refund awaiting payout."
        fields={<>
          <label>Refund amount (BDT)<input name="amount" type="number" inputMode="decimal" min="0.01" max={orderCase.maxRefundMinor / 100}
            step="0.01" defaultValue={approvedAmount === null ? undefined : (approvedAmount / 100).toFixed(2)} readOnly={exactRefund} required /></label>
          <label>Message to shopper<textarea name="note" rows={3} minLength={3} maxLength={1500} required /></label>
        </>}
        command={form => ({ action: "approve-refund", ...identity, amountMinor: refundMinor(form), note: form.get("note") })}
      />
    </section>}

    {orderCase.canConfirmRefund && !orderCase.canApproveRefund && <section className="commerce-panel">
      <h2>Record a completed refund</h2>
      <p>Record confirmation after the payout has completed. The maximum is {formatMoney(orderCase.maxRefundMinor, markets.bd)}.</p>
      <MarketplaceForm endpoint={endpoint} label="Confirm completed refund" success="Refund confirmation recorded."
        fields={<>
          <label>Amount refunded (BDT)<input name="amount" type="number" inputMode="decimal" min="0.01" max={orderCase.maxRefundMinor / 100}
            step="0.01" defaultValue={approvedAmount === null ? undefined : (approvedAmount / 100).toFixed(2)} readOnly={exactRefund} required /></label>
          <label>Method used<input name="method" minLength={2} maxLength={60} required /></label>
          <label>Confirmation reference<input name="reference" minLength={2} maxLength={80} required /></label>
          <label className="mp-remember"><input name="confirmed" type="checkbox" value="yes" required /> I verified the completed payout and amount.</label>
        </>}
        command={form => ({ action: "confirm-refund", ...identity, amountMinor: refundMinor(form),
          method: form.get("method"), reference: form.get("reference"), confirmed: form.get("confirmed") === "yes" })}
      />
      {payoutPending && <details>
        <summary>Report a payout problem</summary>
        <MarketplaceForm endpoint={endpoint} label="Record payout problem" success="Payout problem recorded."
          fields={<label>Message to shopper<textarea name="note" rows={3} minLength={3} maxLength={1500} required /></label>}
          command={form => ({ action: "fail-refund", ...identity, note: form.get("note") })}
        />
      </details>}
    </section>}

    {options.length > 0 && <section className="commerce-panel">
      <h2>Review case</h2>
      <MarketplaceForm endpoint={endpoint} label="Save case update" success="Case updated." reset
        fields={<>
          <label>New status
            <select name="status" required>
              {options.map(next => <option key={next} value={next}>
                {kind === "EXCHANGE" && next === "RETURN_APPROVED" ? "Exchange approved" : caseStatusLabels[next]}
              </option>)}
            </select>
          </label>
          <label>Message to shopper<textarea name="note" rows={4} minLength={3} maxLength={1500} required /></label>
          {options.includes("RETURN_APPROVED") && <p>Include pickup or drop-off instructions when approving the request.</p>}
          {status === "RETURN_RECEIVED" && <p>Complete any applicable refund before resolving the case.</p>}
        </>}
        command={form => ({ action: "review", ...identity, status: form.get("status"), note: form.get("note") })}
      />
    </section>}

    {active && <section className="commerce-panel">
      <h2>Reply to shopper</h2>
      <MarketplaceForm endpoint={endpoint} label="Send reply" success="Reply sent." reset
        fields={<label>Message<textarea name="note" required minLength={3} maxLength={1500} rows={3} /></label>}
        command={form => ({ action: "respond", ...identity, note: form.get("note") })}
      />
    </section>}
  </>;
}
