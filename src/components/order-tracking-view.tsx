"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { type MarketId, isMarketId } from "@/config/markets";
import { store } from "@/config/store";
import { storefrontPath } from "@/config/storefront-path";
import type { BangladeshShipmentSource, OrderStatus, ParcelTrackingSource, ParcelTrackingStatus } from "@/generated/prisma/enums";
import { parcelTrackingStatusLabels } from "@/lib/commerce/parcel-tracking";
import styles from "./order-tracking-view.module.css";

type EventSource = BangladeshShipmentSource | ParcelTrackingSource | "SYSTEM" | "LEGACY";
type Shipment = {
  id: string;
  status: ParcelTrackingStatus;
  carrier: string | null;
  trackingReference: string | null;
  trackingUrl: string | null;
  statusUpdatedAt: string | null;
  estimatedDeliveryAt: string | null;
  lastSyncedAt: string | null;
  items: { orderItemId: string; sku: string; productName: string; variantName: string; quantity: number }[];
  itemsTruncated: boolean;
  events: { status: ParcelTrackingStatus; occurredAt: string | null; receivedAt: string; source: EventSource }[];
  eventsTruncated: boolean;
};
type Tracking = { orderId: string; reference: string; marketId: MarketId; orderStatus: OrderStatus; shipments: Shipment[]; nextCursor: string | null };
type State = {
  tracking?: Tracking;
  checkedAt?: number;
  issue?: "unavailable" | "limited" | "temporary";
  announcement?: string;
  retryAt: number;
};

const checkInterval = 5_000;
const relayLink = "https://www.steadfast.com.bd/tracking";
const eventSource: Record<EventSource, string> = {
  CARRIER_WEBHOOK: "Carrier update",
  MANUAL: "GriipBuddy update",
  SYSTEM: "Order update",
  DEV_SIMULATOR: "Test update",
  LEGACY: "Recorded update",
};

function TrackingTime({ value, format }: { value: string | number; format: Intl.DateTimeFormat }) {
  const date = new Date(value);
  return <time dateTime={date.toISOString()}>{format.format(date)}</time>;
}

function PackageCard({ shipment, number, format }: { shipment: Shipment; number: number; format: Intl.DateTimeFormat }) {
  const status = parcelTrackingStatusLabels[shipment.status];
  const hasCarrierLink = shipment.trackingUrl === relayLink && Boolean(shipment.trackingReference);
  const open = shipment.status !== "DELIVERED" && shipment.status !== "RETURNED";
  return <article className={`commerce-panel ${styles.package}`} aria-labelledby={`package-${shipment.id}`}>
    <header className={styles.heading}>
      <h2 id={`package-${shipment.id}`}>Package {number}</h2>
      <p className={styles.status} data-exception={shipment.status === "DELIVERY_EXCEPTION" || undefined}>{status}</p>
    </header>
    {shipment.status === "DELIVERY_EXCEPTION" && <p>A delivery issue was reported for this package. Check the carrier’s latest update if available, or contact GriipBuddy for help.</p>}
    {shipment.status === "RETURNED" && <p>A return was recorded for this package. For return or refund details, check your order or contact GriipBuddy.</p>}
    <dl className={styles.details}>
      {shipment.carrier && <div><dt>Carrier</dt><dd>{shipment.carrier}</dd></div>}
      {shipment.trackingReference && <div><dt>Tracking reference</dt><dd>{shipment.trackingReference}</dd></div>}
      {open && shipment.estimatedDeliveryAt && <div><dt>Carrier delivery estimate</dt><dd><TrackingTime value={shipment.estimatedDeliveryAt} format={format} /></dd></div>}
      {shipment.statusUpdatedAt && <div><dt>Status updated</dt><dd><TrackingTime value={shipment.statusUpdatedAt} format={format} /></dd></div>}
      {shipment.lastSyncedAt && <div><dt>Last verified carrier update</dt><dd><TrackingTime value={shipment.lastSyncedAt} format={format} /></dd></div>}
    </dl>
    {hasCarrierLink && <a className="text-link" href={relayLink} target="_blank" rel="noopener noreferrer">Carrier tracking (opens in a new tab)</a>}
    {open && shipment.status !== "PREPARING" && <p className="commerce-muted">{shipment.lastSyncedAt
      ? "Carrier updates can take time to appear. Refresh to check for saved updates."
      : "A verified carrier update is not available yet. We’ll show new updates here as they arrive."}</p>}
    {shipment.items.length > 0 && <div>
      <h3>Items in this package</h3>
      <ul className={styles.items} aria-label="Items in this package">{shipment.items.map(item => <li key={item.orderItemId}>
        <strong>{item.quantity} × {item.productName}</strong>
        <span>{[item.variantName, item.sku].filter(Boolean).join(" · ")}</span>
      </li>)}</ul>
      {shipment.itemsTruncated && <p className="commerce-muted">Only the first 50 items in this package are shown here.</p>}
    </div>}
    <div>
      <h3>Tracking timeline</h3>
      {shipment.events.length ? <ol className={styles.timeline} aria-label="Tracking timeline">
        {shipment.events.map((event, index) => <li key={`${event.receivedAt}:${event.status}:${index}`}>
          <strong>{parcelTrackingStatusLabels[event.status]}</strong>
          <span className="commerce-muted">{eventSource[event.source]} · <TrackingTime value={event.occurredAt ?? event.receivedAt} format={format} /></span>
        </li>)}
      </ol> : <p className="commerce-muted">No tracking events have been recorded yet.</p>}
      {shipment.eventsTruncated && <p className="commerce-muted">Showing the 25 most recent updates.</p>}
    </div>
  </article>;
}

export function OrderTrackingView({ orderId, access, locale, timeZones }: {
  orderId: string; access: "account" | "guest"; locale: string; timeZones: Record<MarketId, string>;
}) {
  const [state, setState] = useState<State>({ retryAt: 0 });
  const [action, setAction] = useState<"refresh" | "more" | null>(null);
  const [unlockedAt, setUnlockedAt] = useState(0);
  const active = useRef<AbortController | null>(null);
  const failedReads = useRef(0);
  const read = useCallback(async (after?: string, announce = false) => {
    const controller = new AbortController();
    active.current = controller;
    const path = storefrontPath(`/api/orders/${encodeURIComponent(orderId)}/tracking${access === "guest" ? "/guest" : ""}`);
    const url = after ? `${path}?${new URLSearchParams({ after })}` : path;
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, {
        cache: "no-store", credentials: "same-origin", redirect: "error", referrerPolicy: "no-referrer", signal: controller.signal,
      });
      if (active.current !== controller) return;
      const now = Date.now();
      if (response.status === 404 || response.status === 401 || response.status === 403) {
        setState({ issue: "unavailable", retryAt: 0 });
        return;
      }
      if (response.status === 429) {
        const delay = Number(response.headers.get("Retry-After"));
        const seconds = Number.isFinite(delay) ? Math.max(60, delay) : 60;
        setState(previous => ({ ...previous, issue: "limited", retryAt: now + seconds * 1_000 }));
        return;
      }
      if (!response.ok) throw new Error("Tracking could not be checked.");
      const page = await response.json() as Tracking;
      if (active.current !== controller) return;
      if (page.orderId !== orderId || !isMarketId(page.marketId) || !Array.isArray(page.shipments)) throw new Error("Invalid tracking response.");
      failedReads.current = 0;
      setState(previous => ({
        tracking: after && previous.tracking ? {
          ...page, shipments: [...new Map([...previous.tracking.shipments, ...page.shipments].map(shipment => [shipment.id, shipment])).values()],
        } : page,
        checkedAt: after ? previous.checkedAt : now,
        announcement: announce ? after ? "Package list updated." : "Tracking checked." : undefined,
        retryAt: now + checkInterval,
      }));
    } catch {
      if (active.current !== controller) return;
      failedReads.current = Math.min(failedReads.current + 1, 5);
      const retryAt = Date.now() + Math.min(60_000, checkInterval * 2 ** (failedReads.current - 1));
      setState(previous => ({ ...previous, issue: "temporary", retryAt }));
    } finally {
      window.clearTimeout(timeout);
      if (active.current === controller) {
        active.current = null;
        setAction(null);
      }
    }
  }, [access, orderId]);

  useEffect(() => {
    const start = window.setTimeout(() => { void read(); }, 0);
    return () => {
      window.clearTimeout(start);
      active.current?.abort();
      active.current = null;
    };
  }, [read]);

  useEffect(() => {
    const timer = window.setTimeout(() => setUnlockedAt(state.retryAt), Math.max(0, state.retryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [state.retryAt]);

  const { tracking, checkedAt, issue, announcement, retryAt } = state;
  const checking = (!tracking && !issue) || Boolean(action);
  const waiting = retryAt !== 0 && retryAt !== unlockedAt;
  const format = new Intl.DateTimeFormat(locale, {
    year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    ...(tracking && { timeZone: timeZones[tracking.marketId], timeZoneName: "short" }),
  });

  function check(nextAction: "refresh" | "more") {
    if (active.current || checking || waiting) return;
    const cursor = nextAction === "more" ? tracking?.nextCursor : undefined;
    if (nextAction === "more" && !cursor) return;
    setAction(nextAction);
    void read(cursor ?? undefined, true);
  }

  return <div className="commerce-stack">
    <section className={`commerce-panel ${styles.summary}`} aria-label="Order tracking summary">
      {tracking ? <>
        <div className={styles.heading}>
          <h2>Order <span>{tracking.reference}</span></h2>
          {tracking.orderStatus === "CANCELLED" && <p className={styles.status}>Order cancelled</p>}
        </div>
        {checkedAt && <p className="commerce-muted">Last checked <TrackingTime value={checkedAt} format={format} /></p>}
      </> : issue === "unavailable" && <>
        <h2>Tracking unavailable</h2>
        <p>{access === "guest"
          ? "This order couldn’t be verified in this browser. Guest access may have expired. Try the original checkout browser, sign in if you saved the order to your account, or contact support."
          : "We couldn’t open tracking for this order. Check your orders or contact support."}</p>
      </>}
      <div role="status" className={styles.notice}>
        {checking && <p>{tracking ? "Checking for updates…" : access === "guest" && !issue ? "Verifying this browser…" : "Loading tracking…"}</p>}
        {issue === "limited" && <p>Too many tracking checks. {waiting ? "Wait before trying again." : "You can try again now."}</p>}
        {issue === "temporary" && <p>{tracking ? "Tracking could not be refreshed. The last available information is shown below." : "Tracking is temporarily unavailable. Try again shortly."}</p>}
        {!checking && !issue && announcement && <p>{announcement}</p>}
      </div>
      <div className={styles.actions}>
        {issue !== "unavailable" && (tracking || issue) && <button type="button" className="button button--outline" aria-disabled={checking || waiting} onClick={() => check("refresh")}>
          {tracking ? "Refresh tracking" : "Try again"}
        </button>}
        {access === "account" && tracking && <Link className="text-link" href={`/orders/${orderId}`} prefetch={false}>Order details</Link>}
        <a className="text-link" href={`mailto:${store.supportEmail}`}>Contact support</a>
      </div>
    </section>
    {tracking && (tracking.shipments.length ? tracking.shipments.map((shipment, index) => <PackageCard key={shipment.id} shipment={shipment} number={index + 1} format={format} />)
      : tracking.orderStatus === "PLACED" && <section className="commerce-panel"><h2>Preparing</h2><p>We’ll show package details here once they’re available.</p></section>)}
    {tracking?.nextCursor && <button type="button" className={`button button--outline ${styles.more}`} aria-disabled={checking || waiting} onClick={() => check("more")}>
      Load more packages
    </button>}
  </div>;
}
