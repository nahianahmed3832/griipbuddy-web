import type { BangladeshTracking } from "@/lib/commerce/bangladesh-shipment";
import { customerOrderDate, customerShipmentStatus } from "@/lib/commerce/account-order";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";

type EvidenceByStatus = Partial<Record<BangladeshTracking["status"], string | null>>;

export function BangladeshTrackingTimeline({ shipment, receivedAt, staffEvidence, language = "en" }: {
  shipment: BangladeshTracking; receivedAt?: Date; staffEvidence?: EvidenceByStatus; language?: AccountLanguage;
}) {
  const t = (english: string, bangla: string) => accountText(language, english, bangla);
  return <>
    <p>{shipment.carrier} · <strong>{shipment.trackingReference}</strong></p>
    <p className="commerce-muted">{shipment.source === "DEV_SIMULATOR" ? t("Demo tracking. No real parcel was booked.", "এটি পরীক্ষামূলক ট্র্যাকিং। কোনো পার্সেল বুক করা হয়নি।")
      : t("Updates verified and recorded by GriipBuddy staff.", "GriipBuddy কর্মীরা এই তথ্য যাচাই করে যোগ করেছেন।")}</p>
    <ol className="staff-history" aria-label={t("Shipment updates", "ডেলিভারির খবর")}>
      {shipment.events.map(event => <li key={event.status}>
        <strong>{customerShipmentStatus(event.status, language)}</strong>
        <time dateTime={event.recordedAt.toISOString()}>{customerOrderDate(event.recordedAt, "bd", language, true)}</time>
        {staffEvidence?.[event.status] && <span>Courier reference: {staffEvidence[event.status]}</span>}
      </li>)}
      {receivedAt && <li>
        <strong>{t("Returned to GriipBuddy", "GriipBuddy-তে ফেরত এসেছে")}</strong>
        <time dateTime={receivedAt.toISOString()}>{customerOrderDate(receivedAt, "bd", language, true)}</time>
      </li>}
    </ol>
  </>;
}
