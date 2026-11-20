import Link from "next/link";
import { orderDate } from "@/lib/commerce/labels";
import type { InboxViewer, notificationInbox } from "@/lib/notifications/inbox";
import { NotificationReceiptControl } from "./notification-controls";
import styles from "./notification-workspace.module.css";

export function NotificationInbox({ items, marketId, audience, shopId }: {
  items: Awaited<ReturnType<typeof notificationInbox>>; marketId: InboxViewer["marketId"]; audience: InboxViewer["audience"]; shopId?: string;
}) {
  return <section className="commerce-panel" aria-labelledby="m11-notification-title">
    <h2 id="m11-notification-title" className={styles.subtitle}>Recent activity</h2>
    {items.length ? <ul className={styles.list}>{items.map(event => <li key={event.key}>
      <div>
        <h3><Link href={event.href} className="text-link" prefetch={false}>{event.title}</Link></h3>
        <p className={styles.meta}><span>{event.reference}</span><time dateTime={event.occurredAt.toISOString()}>{orderDate(event.occurredAt, marketId)}</time>
          <span>{event.read ? "Read" : "Unread"}</span></p>
      </div>
      <NotificationReceiptControl eventKey={event.key} read={event.read} marketId={marketId} audience={audience} shopId={shopId}/>
    </li>)}</ul> : <p>No recent notifications in this market.</p>}
  </section>;
}
