import { randomUUID } from "node:crypto";
import { dispatchParcelAction, prepareParcelAction, receiveRefusedParcelAction, recordParcelExceptionAction,
  recordParcelTrackingAction, splitParcelAction, updateParcelReferenceAction } from "@/app/staff/actions";
import { StaffActionForm } from "@/components/staff-actions";
import type { MarketId } from "@/config/markets";
import { orderDate } from "@/lib/commerce/labels";
import { canEditParcelReference, canRecordParcelException, orderParcelSplitsPaused } from "@/lib/commerce/order-parcels";
import { canAdvanceParcelTracking, currentParcelTrackingStatus, nextOrderParcelStatuses, normalizedParcelEventStatus,
  orderParcelStatusLabels, parcelItemsToShip, parcelPreparationLabels, parcelTrackingStatusLabels, type OrderParcelStaffTracking } from "@/lib/commerce/parcel-tracking";

type Parcel = OrderParcelStaffTracking;

function DispatchParcel({ orderId, parcel, simulate }: { orderId: string; parcel: Parcel; simulate: boolean }) {
  return <StaffActionForm action={dispatchParcelAction.bind(null, orderId, parcel.id)} submitLabel="Dispatch parcel">
    <input name="operationId" type="hidden" value={randomUUID()} />
    {simulate ? <>
      <input name="simulate" type="hidden" value="yes" />
      <p className="commerce-muted">The demo courier assigns a test tracking reference to this parcel.</p>
    </> : <>
      <label>Carrier<input name="carrier" defaultValue={parcel.carrier ?? ""} maxLength={60} required /></label>
      <label>Tracking reference<input name="trackingReference" defaultValue={parcel.trackingReference ?? ""} maxLength={80} required /></label>
    </>}
  </StaffActionForm>;
}

function TrackParcel({ orderId, parcel, owner }: { orderId: string; parcel: Parcel; owner: boolean }) {
  const next = nextOrderParcelStatuses(parcel.status).filter(status => status === "REFUSED" ? owner
    : canAdvanceParcelTracking(currentParcelTrackingStatus(parcel), normalizedParcelEventStatus(status)));
  if (!next.length) return null;
  const simulated = parcel.source === "DEV_SIMULATOR";
  return <StaffActionForm action={recordParcelTrackingAction.bind(null, orderId, parcel.id)} submitLabel={simulated ? "Run demo parcel update" : "Record parcel update"}>
    <label>Parcel status<select name="status" defaultValue="" required>
      <option value="" disabled>Choose a status</option>
      {next.map(status => <option key={status} value={status}>{orderParcelStatusLabels[status]}</option>)}
    </select></label>
    {!simulated && <label>Courier evidence reference<input name="evidence" minLength={3} maxLength={200} required /></label>}
  </StaffActionForm>;
}

function ParcelQuantities({ parcel, split }: { parcel: Parcel; split?: boolean }) {
  return parcelItemsToShip(parcel.items).map(({ orderItem, quantity }) => <label key={orderItem.id}>
    {orderItem.sku} · {quantity} allocated
    <input name={`quantity-${orderItem.id}`} type="number" min={split ? 0 : 1} max={quantity} step={1} required={!split} />
  </label>);
}

function PrepareParcel({ orderId, parcel }: { orderId: string; parcel: Parcel }) {
  const next = parcel.preparationState === "PENDING" ? "PICKED" : "PACKED";
  return <StaffActionForm action={prepareParcelAction.bind(null, orderId, parcel.id)} submitLabel={next === "PICKED" ? "Confirm picked quantities" : "Confirm packed quantities"}>
    <input name="operationId" type="hidden" value={randomUUID()} />
    <input name="revision" type="hidden" value={parcel.trackingRevision} />
    <input name="next" type="hidden" value={next} />
    <ParcelQuantities parcel={parcel} />
  </StaffActionForm>;
}

function SplitParcel({ orderId, parcel }: { orderId: string; parcel: Parcel }) {
  return <details><summary>Split this parcel</summary>
    <StaffActionForm action={splitParcelAction.bind(null, orderId, parcel.id)} submitLabel="Save parcel split" secondary>
      <input name="operationId" type="hidden" value={randomUUID()} />
      <p>Enter quantities for the new parcel. Leave at least one item in this parcel.</p>
      <ParcelQuantities parcel={parcel} split />
      <label>Split reason<input name="reason" minLength={3} maxLength={200} required /></label>
    </StaffActionForm>
  </details>;
}

function EditParcelReference({ orderId, parcel }: { orderId: string; parcel: Parcel }) {
  return <details><summary>Edit tracking reference</summary>
    <StaffActionForm action={updateParcelReferenceAction.bind(null, orderId, parcel.id)} submitLabel="Save tracking reference" secondary>
      <input name="revision" type="hidden" value={parcel.trackingRevision} />
      <label>Carrier<input name="carrier" defaultValue={parcel.carrier ?? ""} maxLength={60} required /></label>
      <label>Tracking reference<input name="trackingReference" defaultValue={parcel.trackingReference ?? ""} maxLength={80} required /></label>
      <label>Revision reason<input name="reason" minLength={3} maxLength={200} required /></label>
    </StaffActionForm>
  </details>;
}

function ReceiveParcel({ orderId, parcelId }: { orderId: string; parcelId: string }) {
  return <StaffActionForm action={receiveRefusedParcelAction.bind(null, orderId, parcelId)} submitLabel="Record parcel receipt">
    <label>Stock decision<select name="disposition" defaultValue="" required>
      <option value="" disabled>Choose after inspection</option>
      <option value="RESTOCK">Restock this parcel’s complete, sellable items</option>
      <option value="HOLD">Hold this parcel’s items for review</option>
    </select></label>
    <label>Warehouse note<textarea name="note" minLength={3} maxLength={200} required /></label>
    <label className="commerce-option"><input type="checkbox" name="confirm" value="yes" required /> I received and inspected this parcel.</label>
  </StaffActionForm>;
}

export function StaffOrderParcels({ orderId, marketId, parcels, active, owner, canPrepare, canDispatch, simulate }: {
  orderId: string; marketId: MarketId; parcels: Parcel[]; active: boolean; owner: boolean; canPrepare: boolean; canDispatch: boolean; simulate: boolean;
}) {
  const splitsPaused = orderParcelSplitsPaused();
  return <div className="commerce-stack">
    <h2>Parcels</h2>
    {parcels.map((parcel, index) => (
      <section className="commerce-panel" key={parcel.id} aria-label={`Parcel ${index + 1} · ${parcel.locationName}`}>
        <h3>Parcel {index + 1} · {parcel.locationName}</h3>
        <p>{!active ? "Cancelled" : parcel.status === "PLANNED" && parcel.preparationState ? parcelPreparationLabels[parcel.preparationState] :
          parcel.trackingStatus === "DELIVERY_EXCEPTION" || parcel.trackingStatus === "RETURNED" && parcel.status !== "RETURNED"
            ? parcelTrackingStatusLabels[parcel.trackingStatus] : orderParcelStatusLabels[parcel.status]}</p>
        <ul>
          {parcelItemsToShip(parcel.items).map(({ orderItem, quantity }) => <li key={orderItem.id}>{quantity} × {orderItem.productName} · {orderItem.variantName} · {orderItem.sku}</li>)}
        </ul>
        {parcel.carrier && <p>{parcel.carrier} · {parcel.trackingReference}</p>}
        {parcel.events.length > 0 && <ol className="staff-history">
          {parcel.events.map(event => <li key={event.status}>
            <strong>{orderParcelStatusLabels[event.status]}</strong>
            <time dateTime={event.recordedAt.toISOString()}>{orderDate(event.recordedAt, marketId)}</time>
            {owner && event.evidence && <span>Evidence: {event.evidence}</span>}
          </li>)}
        </ol>}
        {parcel.status === "RETURNED" && <p>{parcel.returnDisposition === "RESTOCK"
          ? "This parcel’s items were restocked at their original dispatch location." : "This parcel’s items are held for review."}</p>}
        {parcel.preparationEvents.length > 0 && <ol className="staff-history" aria-label="Pick and pack history">
          {parcel.preparationEvents.map(event => <li key={event.operationId}><strong>{parcelPreparationLabels[event.state]}</strong>
            <time dateTime={event.recordedAt.toISOString()}>{orderDate(event.recordedAt, marketId)}</time></li>)}
        </ol>}
        {canPrepare && parcel.status === "PLANNED" && (parcel.preparationState === "PENDING" || parcel.preparationState === "PICKED") &&
          <PrepareParcel key={parcel.trackingRevision} orderId={orderId} parcel={parcel} />}
        {active && !splitsPaused && parcel.status === "PLANNED" && (parcel.preparationState === null || parcel.preparationState === "PENDING") &&
          parcelItemsToShip(parcel.items).reduce((total, line) => total + line.quantity, 0) > 1 && <SplitParcel orderId={orderId} parcel={parcel} />}
        {canDispatch && parcel.status === "PLANNED" && (parcel.preparationState === null || parcel.preparationState === "PACKED") &&
          <DispatchParcel orderId={orderId} parcel={parcel} simulate={simulate} />}
        {active && canEditParcelReference(parcel) && <EditParcelReference orderId={orderId} parcel={parcel} />}
        {active && canRecordParcelException(parcel) && <details><summary>Record a delivery exception</summary>
          <StaffActionForm action={recordParcelExceptionAction.bind(null, orderId, parcel.id)} submitLabel="Save delivery exception" secondary>
            <label>Exception reason<input name="reason" minLength={3} maxLength={200} required /></label>
          </StaffActionForm>
        </details>}
        {active && <TrackParcel key={parcel.status} orderId={orderId} parcel={parcel} owner={owner} />}
        {active && parcel.status === "REFUSED" && <ReceiveParcel orderId={orderId} parcelId={parcel.id} />}
      </section>
    ))}
  </div>;
}
