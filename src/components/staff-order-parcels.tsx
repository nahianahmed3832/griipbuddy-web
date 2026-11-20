import { dispatchParcelAction, receiveRefusedParcelAction, recordParcelTrackingAction } from "@/app/staff/actions";
import { StaffActionForm } from "@/components/staff-actions";
import type { MarketId } from "@/config/markets";
import { orderDate } from "@/lib/commerce/labels";
import { nextOrderParcelStatuses, orderParcelStatusLabels, type OrderParcelStaffTracking } from "@/lib/commerce/parcel-tracking";

type Parcel = OrderParcelStaffTracking;

function DispatchParcel({ orderId, parcelId, simulate }: { orderId: string; parcelId: string; simulate: boolean }) {
  return <StaffActionForm action={dispatchParcelAction.bind(null, orderId, parcelId)} submitLabel="Dispatch parcel">
    {simulate ? <>
      <input name="simulate" type="hidden" value="yes" />
      <p className="commerce-muted">The demo courier assigns a test tracking reference to this parcel.</p>
    </> : <>
      <label>Carrier<input name="carrier" maxLength={60} required /></label>
      <label>Tracking reference<input name="trackingReference" maxLength={80} required /></label>
    </>}
  </StaffActionForm>;
}

function TrackParcel({ orderId, parcel, owner }: { orderId: string; parcel: Parcel; owner: boolean }) {
  const next = nextOrderParcelStatuses(parcel.status).filter(status => status !== "REFUSED" || owner);
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

export function StaffOrderParcels({ orderId, marketId, parcels, active, owner, canDispatch, simulate }: {
  orderId: string; marketId: MarketId; parcels: Parcel[]; active: boolean; owner: boolean; canDispatch: boolean; simulate: boolean;
}) {
  return <div className="commerce-stack">
    <h2>Parcels</h2>
    {parcels.map((parcel, index) => (
      <section className="commerce-panel" key={parcel.id} aria-label={`Parcel ${index + 1} · ${parcel.locationName}`}>
        <h3>Parcel {index + 1} · {parcel.locationName}</h3>
        <p>{active ? orderParcelStatusLabels[parcel.status] : "Cancelled"}</p>
        <ul>
          {parcel.items.map(({ orderItem, quantity }) => <li key={orderItem.id}>{quantity} × {orderItem.productName} · {orderItem.variantName} · {orderItem.sku}</li>)}
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
        {canDispatch && parcel.status === "PLANNED" && <DispatchParcel orderId={orderId} parcelId={parcel.id} simulate={simulate} />}
        {active && <TrackParcel key={parcel.status} orderId={orderId} parcel={parcel} owner={owner} />}
        {active && parcel.status === "REFUSED" && <ReceiveParcel orderId={orderId} parcelId={parcel.id} />}
      </section>
    ))}
  </div>;
}
