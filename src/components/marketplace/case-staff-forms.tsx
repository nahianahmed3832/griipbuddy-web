"use client";

import type { OrderCaseKind, OrderCaseRefundState, OrderCaseStatus } from "@/generated/prisma/enums";
import { formatMoney, type Market } from "@/config/markets";
import { caseStatusLabels, ownerCaseTransitions } from "@/lib/marketplace/case-policy";
import { MarketplaceForm } from "./action-form";

const endpoint = "/api/marketplace/cases";

type StaffCase = {
  id: string;
  revision: number;
  kind: OrderCaseKind;
  status: OrderCaseStatus;
  returnLines: readonly unknown[];
  refundLimitMinor: number | null;
  requiresCancellationRefund: boolean;
  canApproveCancellation: boolean;
  canProcessRefund: boolean;
  refund?: { state: OrderCaseRefundState } | null;
};

function StaffNote() {
  return <label>Internal case note<textarea name="note" rows={3} minLength={3} maxLength={1500} required /></label>;
}

function RecordPickup({ orderCase, timeZone }: { orderCase: StaffCase; timeZone: string }) {
  const reschedule = orderCase.status === "PICKUP_SCHEDULED";
  return (
    <section className="commerce-panel">
      <h2>{reschedule ? "Reschedule return pickup" : "Arrange return pickup"}</h2>
      <p>Arrange pickup with the courier, then record the agreed time and reference here.</p>
      <MarketplaceForm endpoint={endpoint} label="Save pickup details" success="Pickup details saved."
        fields={<>
          <label>Pickup date and time ({timeZone})<input name="pickupAt" type="datetime-local" required /></label>
          <label>Courier pickup reference<input name="pickupReference" minLength={3} maxLength={80} required /></label>
          <StaffNote />
        </>}
        command={form => ({
          action: "schedule-pickup", caseId: orderCase.id, revision: orderCase.revision,
          pickupAt: form.get("pickupAt"),
          pickupReference: form.get("pickupReference"), note: form.get("note"),
        })}
      />
    </section>
  );
}

function ReceiveParcel({ orderCase }: { orderCase: StaffCase }) {
  return (
    <section className="commerce-panel">
      <h2>Receive and inspect items</h2>
      <p>Match the received items and quantities to this case. If any quantity is missing, leave the case open and check with the shopper.</p>
      <MarketplaceForm endpoint={endpoint} label="Record return receipt" success="Return receipt recorded."
        fields={<>
          <label>
            Stock decision
            <select name="disposition" required defaultValue="">
              <option value="" disabled>Choose after inspection</option>
              <option value="RESTOCK">Restock the items (complete and sellable)</option>
              <option value="HOLD">Hold for review (damaged or condition uncertain)</option>
            </select>
          </label>
          <label className="mp-remember"><input name="confirmed" type="checkbox" value="yes" required /> I received and inspected every listed item and quantity.</label>
        </>}
        command={form => ({
          action: "receive", caseId: orderCase.id, revision: orderCase.revision,
          disposition: form.get("disposition"), confirmed: form.get("confirmed") === "yes",
        })}
      />
    </section>
  );
}

function ApproveRefund({ orderCase, limitMinor, cancellation, market }: {
  orderCase: StaffCase; limitMinor: number; cancellation: boolean; market: Market;
}) {
  const scale = 10 ** market.minorDigits;
  const amount = (limitMinor / scale).toFixed(market.minorDigits);
  const step = (1 / scale).toFixed(market.minorDigits);
  const formatted = formatMoney(limitMinor, market);
  const exchange = orderCase.kind === "EXCHANGE";
  const label = cancellation ? "Approve legacy cancellation and refund" : exchange ? "Approve refund instead" : "Approve refund";
  return (
    <section className="commerce-panel">
      <h2>{label}</h2>
      <p>{cancellation ? `Cancel the order and authorize the original payment refund of ${formatted}.` : `The selected items are eligible for up to ${formatted}.`}</p>
      {exchange && <p>Confirm the refund choice with the shopper before changing the exchange.</p>}
      <p className="commerce-muted">Confirm the original payment refund separately before closing this case.</p>
      <MarketplaceForm endpoint={endpoint} label={label} success="Refund approval recorded."
        fields={<>
          {!cancellation && <label>Refund amount ({market.currency})<input name="amount" type="number" min={step} max={amount} step={step} defaultValue={amount} required /></label>}
          <StaffNote />
        </>}
        command={form => ({
          action: "approve-refund", caseId: orderCase.id, revision: orderCase.revision,
          amountMinor: cancellation ? limitMinor : Math.round(Number(form.get("amount")) * scale), note: form.get("note"),
        })}
      />
    </section>
  );
}

function ShipExchange({ orderCase }: { orderCase: StaffCase }) {
  return (
    <section className="commerce-panel">
      <h2>Send replacement items</h2>
      <p>Check the requested variants and quantities before handing them to the courier. Recording the shipment deducts those units from available stock.</p>
      <MarketplaceForm endpoint={endpoint} label="Record replacement shipment" success="Replacement shipment recorded."
        fields={<>
          <label>Replacement tracking reference<input name="trackingReference" minLength={3} maxLength={80} required /></label>
          <StaffNote />
        </>}
        command={form => ({
          action: "ship-exchange", caseId: orderCase.id, revision: orderCase.revision,
          trackingReference: form.get("trackingReference"), note: form.get("note"),
        })}
      />
    </section>
  );
}

function ApproveCancellation({ orderCase }: { orderCase: StaffCase }) {
  return (
    <section className="commerce-panel">
      <h2>Approve cancellation</h2>
      <p>{orderCase.returnLines.length > 0
        ? "Cancel the eligible quantities in this request and release their allocation. Any refund is reviewed separately."
        : "Cancel this unshipped order, restore its items to stock, and void the amount due on delivery."}</p>
      <MarketplaceForm endpoint={endpoint} label="Approve cancellation" success="Cancellation recorded."
        fields={<StaffNote />}
        command={form => ({
          action: "approve-cancellation", caseId: orderCase.id, revision: orderCase.revision, note: form.get("note"),
        })}
      />
    </section>
  );
}

function ProcessRefund({ orderCase }: { orderCase: StaffCase }) {
  const processing = orderCase.refund?.state === "PROCESSING";
  return <section className="commerce-panel">
    <h2>Original payment refund</h2>
    <p>{processing ? "Check the existing test refund for confirmation." : "Send the approved refund to the configured test payment provider."}</p>
    <MarketplaceForm endpoint={endpoint} label={processing ? "Check refund status" : "Process approved refund"}
      success="Refund status checked."
      command={() => ({ action: "process-refund", caseId: orderCase.id, revision: orderCase.revision })}/>
  </section>;
}

function ReviewStatus({ orderCase, options }: { orderCase: StaffCase; options: readonly OrderCaseStatus[] }) {
  const statusLabel = (status: OrderCaseStatus) => orderCase.kind === "EXCHANGE" && status === "RETURN_APPROVED"
    ? "Exchange approved" : caseStatusLabels[status];
  return (
    <section className="commerce-panel">
      <h2>Review case</h2>
      <MarketplaceForm endpoint={endpoint} label="Save case update" success="Case updated." reset
        fields={<>
          <label>
            New status
            <select name="status" required defaultValue="">
              <option value="" disabled>Choose a status</option>
              {options.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}
            </select>
          </label>
          <StaffNote />
          <label>Message to shopper (optional)<textarea name="publicNote" rows={3} minLength={3} maxLength={1500} /></label>
          {options.includes("RETURN_APPROVED") && <p>Add any return instructions to the shopper message.</p>}
          {orderCase.status === "RETURN_RECEIVED" && <p>Use Resolved when the case can close without a new refund approval.</p>}
        </>}
        command={form => ({ action: "review", caseId: orderCase.id, revision: orderCase.revision, status: form.get("status"),
          note: form.get("note"), publicNote: String(form.get("publicNote") ?? "").trim() || undefined })}
      />
    </section>
  );
}

export function ReviewOrderCase({ orderCase, market }: { orderCase: StaffCase; market: Market & { timeZone: string } }) {
  const { kind, status, refundLimitMinor, requiresCancellationRefund, canApproveCancellation } = orderCase;
  const hasReturnLines = orderCase.returnLines.length > 0;
  const parcel = hasReturnLines && (kind === "RETURN" || kind === "EXCHANGE");
  const cancellationReview = kind === "CANCEL" && status === "IN_REVIEW";
  const refundLimit = refundLimitMinor ?? 0;
  const approveRefund = refundLimit > 0 && ((parcel && status === "RETURN_RECEIVED") ||
    (cancellationReview && requiresCancellationRefund) || (kind === "CANCEL" && status === "CANCELLATION_APPROVED"));
  const options = ownerCaseTransitions(kind, status, hasReturnLines)
    .filter(option => !(option === "RESOLVED" && status === "REFUND_APPROVED" && orderCase.refund?.state !== "CONFIRMED"));

  return <>
    {parcel && (status === "RETURN_APPROVED" || status === "PICKUP_SCHEDULED") && <RecordPickup key={orderCase.revision} orderCase={orderCase} timeZone={market.timeZone} />}
    {parcel && (status === "RETURN_APPROVED" || status === "PICKUP_SCHEDULED") && <ReceiveParcel orderCase={orderCase} />}
    {kind === "EXCHANGE" && status === "RETURN_RECEIVED" && <ShipExchange orderCase={orderCase} />}
    {cancellationReview && canApproveCancellation && <ApproveCancellation orderCase={orderCase} />}
    {cancellationReview && !canApproveCancellation && !requiresCancellationRefund && <section className="commerce-panel">
      <h2>Cancellation needs review</h2>
      <p>Check the order’s current fulfillment and payment before responding to the shopper.</p>
    </section>}
    {approveRefund && <ApproveRefund orderCase={orderCase} limitMinor={refundLimit} cancellation={cancellationReview} market={market} />}
    {orderCase.canProcessRefund && <ProcessRefund orderCase={orderCase}/>}
    {options.length > 0 && <ReviewStatus key={orderCase.revision} orderCase={orderCase} options={options} />}
  </>;
}
