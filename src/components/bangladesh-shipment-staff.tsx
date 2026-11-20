import { recordBangladeshTrackingAction } from "@/app/staff/actions";
import { BangladeshTrackingTimeline } from "@/components/bangladesh-tracking";
import { StaffActionForm } from "@/components/staff-actions";
import type { MarketId } from "@/config/markets";
import { devShipmentAvailable, type BangladeshStaffTracking } from "@/lib/commerce/bangladesh-shipment";
import { bangladeshTrackingLabels, nextBangladeshTrackingStatuses } from "@/lib/commerce/bangladesh-shipment-status";

type ShipmentOrder = { id: string; marketId: MarketId; measurementTest: boolean | null; commercialSnapshot?: unknown };

export function StaffBangladeshDispatchFields({ order }: { order: ShipmentOrder }) {
  if (devShipmentAvailable(order)) {
    return <>
      <input type="hidden" name="simulate" value="yes" />
      <p className="commerce-muted">The demo courier creates a test tracking reference. No real parcel will be booked.</p>
    </>;
  }
  return <>
    <label>Carrier<input name="carrier" maxLength={60} required /></label>
    <label>Tracking reference<input name="trackingReference" maxLength={80} required /></label>
    <p className="commerce-muted">Enter the reference from your confirmed courier handoff.</p>
  </>;
}

export function StaffBangladeshTracking({ order, owner }: {
  order: ShipmentOrder & { bangladeshShipment: BangladeshStaffTracking | null; status: string };
  owner: boolean;
}) {
  const shipment = order.bangladeshShipment;
  if (!shipment) return null;
  const nextStatuses = order.status === "PLACED" && (shipment.source === "MANUAL" || devShipmentAvailable(order))
    ? nextBangladeshTrackingStatuses(shipment.status).filter(status => status !== "REFUSED" || owner)
    : [];
  const simulated = shipment.source === "DEV_SIMULATOR";
  return <section className="commerce-panel">
    <h2>Bangladesh shipment tracking</h2>
    <BangladeshTrackingTimeline shipment={shipment}
      staffEvidence={owner ? Object.fromEntries(shipment.events.map(event => [event.status, event.evidence])) : undefined} />
    {nextStatuses.length > 0 && <StaffActionForm key={shipment.status} action={recordBangladeshTrackingAction.bind(null, order.id)}
      submitLabel={simulated ? "Run demo courier update" : "Record courier update"}>
      <label>Courier status<select name="status" defaultValue="" required>
        <option value="" disabled>Choose a status</option>
        {nextStatuses.map(status => <option value={status} key={status}>{bangladeshTrackingLabels[status]}</option>)}
      </select></label>
      {!simulated && <label>Courier evidence reference<input name="evidence" minLength={3} maxLength={200} required /></label>}
      {nextStatuses.includes("REFUSED") && <p className="commerce-muted">Record refusal only after the courier confirms it. Stock is checked in separately when the parcel comes back.</p>}
    </StaffActionForm>}
  </section>;
}
