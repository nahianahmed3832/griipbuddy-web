import type { BangladeshTracking } from "@/lib/commerce/bangladesh-shipment";
import { bangladeshTrackingLabels } from "@/lib/commerce/bangladesh-shipment-status";
import { orderDate } from "@/lib/commerce/labels";

type EvidenceByStatus = Partial<Record<BangladeshTracking["status"], string | null>>;

export function BangladeshTrackingTimeline({ shipment, receivedAt, staffEvidence }: {
  shipment: BangladeshTracking; receivedAt?: Date; staffEvidence?: EvidenceByStatus;
}) {
  return <>
    <p>{shipment.carrier} · <strong>{shipment.trackingReference}</strong></p>
    <p className="commerce-muted">{shipment.source === "DEV_SIMULATOR" ? "Demo tracking. No real parcel was booked." : "Updates verified and recorded by GriipBuddy staff."}</p>
    <ol className="staff-history" aria-label="Shipment updates">
      {shipment.events.map(event => <li key={event.status}>
        <strong>{bangladeshTrackingLabels[event.status]}</strong>
        <time dateTime={event.recordedAt.toISOString()}>{orderDate(event.recordedAt)}</time>
        {staffEvidence?.[event.status] && <span>Courier reference: {staffEvidence[event.status]}</span>}
      </li>)}
      {receivedAt && <li>
        <strong>Returned to GriipBuddy</strong>
        <time dateTime={receivedAt.toISOString()}>{orderDate(receivedAt)}</time>
      </li>}
    </ol>
  </>;
}
