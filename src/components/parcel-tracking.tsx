import type { MarketId } from "@/config/markets";
import { orderDate } from "@/lib/commerce/labels";
import { orderParcelStatusLabels, type OrderParcelTracking } from "@/lib/commerce/parcel-tracking";

export function OrderParcelTrackingList({ parcels, marketId }: {
  parcels: readonly OrderParcelTracking[];
  marketId: MarketId;
}) {
  return <section className="order-tracking" aria-label="Parcel tracking">
    <h3>Parcel tracking</h3>
    {parcels.map((parcel, index) => (
      <section key={parcel.id} className="order-tracking" aria-label={`Parcel ${index + 1}`}>
        <h4><strong>Parcel {index + 1} · {parcel.locationName}</strong></h4>
        <p>{orderParcelStatusLabels[parcel.status]}</p>
        {parcel.carrier && parcel.trackingReference && <p>{parcel.carrier} · <strong className="break-words">{parcel.trackingReference}</strong></p>}
        {parcel.source === "DEV_SIMULATOR" && <p className="commerce-muted">Demo tracking. No real parcel was booked.</p>}
        <ul className="staff-history" aria-label="Items in this parcel">
          {parcel.items.map(({ quantity, orderItem }) => (
            <li key={orderItem.id}>{quantity} × {orderItem.productName}{orderItem.variantName && ` · ${orderItem.variantName}`}</li>
          ))}
        </ul>
        {parcel.events.length > 0 && <ol className="staff-history" aria-label="Parcel updates">
          {parcel.events.map(event => <li key={event.status}>
            <strong>{orderParcelStatusLabels[event.status]}</strong>
            <time dateTime={event.recordedAt.toISOString()}>{orderDate(event.recordedAt, marketId)}</time>
          </li>)}
        </ol>}
      </section>
    ))}
  </section>;
}
