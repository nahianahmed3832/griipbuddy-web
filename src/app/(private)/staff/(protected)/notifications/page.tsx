import Link from "next/link";
import { notFound } from "next/navigation";
import { NotificationInbox } from "@/components/notification-inbox";
import { NotificationTestRetry, OrderNotificationPolicy, SyntheticNewsletter } from "@/components/notification-controls";
import styles from "@/components/notification-workspace.module.css";
import { markets } from "@/config/markets";
import { orderDate } from "@/lib/commerce/labels";
import { getDb } from "@/lib/db/client";
import { marketConfiguration } from "@/lib/market-config";
import { requireStaff } from "@/lib/staff/access";
import { staffMarketIds } from "@/lib/staff/market-access";
import { NotificationError, notificationInbox } from "@/lib/notifications/inbox";
import { testDeliveryStatus } from "@/lib/notifications/test-delivery";
import { whatsAppContact } from "@/lib/notifications/whatsapp";

export const metadata = { title: "Staff notifications", robots: { index: false, follow: false } };
const statuses = { QUEUED: "Queued", RETRY_PENDING: "Retry scheduled", SINK_ACCEPTED: "Recorded by test sink", FAILED: "Test failed" } as const;
const attemptReasons: Record<string, string> = { OPT_IN_OR_CONFIGURATION_CHANGED: "Scoped opt-in or configuration changed",
  TEMPORARY_TEST_SINK_FAILURE: "Temporary test sink failure" };

export default async function StaffNotifications({ searchParams }: { searchParams: Promise<{ market?: string }> }) {
  const actor = await requireStaff();
  const [permitted, query] = await Promise.all([staffMarketIds(actor.id, "operations"), searchParams]);
  const marketId = typeof query.market === "string" ? permitted.find(id => id === query.market) : permitted[0];
  if (!marketId) notFound();
  const items = await notificationInbox({ audience: "staff", actorId: actor.id, marketId })
    .catch(error => { if (error instanceof NotificationError) notFound(); throw error; });
  const owner = actor.role === "OWNER";
  const db = getDb();
  const policy = owner ? await db.notificationOrderPolicy.findUnique({ where: { marketId } }) : null;
  const delivery = owner ? await testDeliveryStatus(actor.id, marketId) : null;
  const subscribers = owner ? await db.newsletterRequest.count({ where: { marketId } }) : null;
  return <div className={styles.grid}>
    <div className="commerce-intro"><h1 className="display-type">Notifications</h1>
      <p>{marketConfiguration(marketId).name} operational inbox and communication settings.</p></div>
    <nav className={styles.actions} aria-label="Notification markets">
      {permitted.map(id => <Link key={id} href={`/staff/notifications?market=${id}`} className="button button--outline"
        aria-current={id === marketId ? "page" : undefined} prefetch={false}>{markets[id].name}</Link>)}
    </nav>
    <NotificationInbox items={items} marketId={marketId} audience="staff"/>
    {owner && <>
      <section className="commerce-panel">
        <h2 className={styles.subtitle}>Order alerts</h2>
        <p>Choose which order events appear in the market inboxes.</p>
        <OrderNotificationPolicy key={marketId} marketId={marketId} placed={policy?.placed ?? true} fulfillment={policy?.fulfillment ?? true}/>
      </section>
      <section className="commerce-panel">
        <h2 className={styles.subtitle}>Communication status</h2>
        <dl>
          <dt>Newsletter opt-in requests</dt><dd>{subscribers}</dd>
          <dt>WhatsApp browser handoff</dt><dd>{whatsAppContact(marketId) ? "Configured for development" : "Unavailable"}</dd>
          <dt>Live email, SMS and push</dt><dd>Provider approval required</dd>
        </dl>
      </section>
    </>}
    {delivery && <section className="commerce-panel">
      <h2 className={styles.subtitle}>Synthetic newsletter delivery</h2>
      {delivery.ready ? delivery.subscribed ? <SyntheticNewsletter key={marketId} marketId={marketId}/>
        : <p>An opted-in synthetic address is required in this market.</p> : <p>The local test sink is unavailable for this market.</p>}
      {delivery.jobs.length > 0 && <ul className={styles.list}>{delivery.jobs.map(job => <li key={job.id}>
        <div><h3>{statuses[job.state]}</h3><p className={styles.meta}><span>{job.locale}</span><span>Attempts {job.attemptCount}</span>
          <time dateTime={job.nextAt.toISOString()}>{orderDate(job.nextAt, marketId)}</time>
          {job.attempts[0]?.reason && <span>{attemptReasons[job.attempts[0].reason]}</span>}</p></div>
        {job.state === "FAILED" && job.attemptCount < 6 && delivery.subscribed && <NotificationTestRetry marketId={marketId} id={job.id}/>}
      </li>)}</ul>}
    </section>}
  </div>;
}
