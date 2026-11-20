"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import type { MarketId } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import type { InboxAudience } from "@/lib/notifications/inbox";
import styles from "./notification-workspace.module.css";

function useNotificationAction() {
  const router = useRouter();
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ message: string; error: boolean }>();
  async function submit(command: object) {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    setStatus(undefined);
    try {
      const response = await fetch(storefrontPath("/api/notifications"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
      });
      const data = await response.json();
      setStatus({ message: data.message, error: !response.ok });
      if (response.ok) router.refresh();
      return response.ok;
    } catch {
      setStatus({ message: "The request could not be confirmed. Try again.", error: true });
      return false;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return { busy, submit, status };
}

function Feedback({ status }: { status?: { message: string; error: boolean } }) {
  return status ? <p role={status.error ? "alert" : "status"}>{status.message}</p> : null;
}

export function NotificationReceiptControl({ eventKey, read, audience, marketId, shopId }: {
  eventKey: string; read: boolean; audience: InboxAudience; marketId: MarketId; shopId?: string;
}) {
  const { submit, busy, status } = useNotificationAction();
  const mark = (dismiss: boolean) => void submit({ action: "mark", audience, marketId, key: eventKey, dismiss, shopId });
  return <div>
    <div className={styles.actions}>
      {!read && <button className="button button--outline" type="button" disabled={busy} onClick={() => mark(false)}>Mark read</button>}
      <button className="button button--outline" type="button" disabled={busy} onClick={() => mark(true)}>Dismiss</button>
    </div>
    <Feedback status={status}/>
  </div>;
}

export function OrderNotificationPolicy({ marketId, placed, fulfillment }: { marketId: MarketId; placed: boolean; fulfillment: boolean }) {
  const { submit, busy, status } = useNotificationAction();
  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void submit({ action: "order-policy", marketId, placed: form.has("placed"), fulfillment: form.has("fulfillment") });
  }
  return <form method="post" className={styles.form} onSubmit={save}>
    <label><input name="placed" type="checkbox" defaultChecked={placed}/> Order placed</label>
    <label><input name="fulfillment" type="checkbox" defaultChecked={fulfillment}/> Order status and cancellation</label>
    <button className="button button--outline" disabled={busy}>Save alert settings</button>
    <Feedback status={status}/>
  </form>;
}

export function SyntheticNewsletter({ marketId }: { marketId: MarketId }) {
  const { submit, busy, status } = useNotificationAction();
  const draft = useRef<{ subject: FormDataEntryValue | null; body: FormDataEntryValue | null; operationId: string } | null>(null);
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const subject = values.get("subject");
    const body = values.get("body");
    if (!draft.current || subject !== draft.current.subject || body !== draft.current.body) {
      draft.current = { subject, body, operationId: crypto.randomUUID() };
    }
    if (await submit({ action: "queue-test", marketId, ...draft.current })) {
      draft.current = null;
      form.reset();
    }
  }
  return <form className={styles.form} method="post" onSubmit={send}>
    <label>Subject<input name="subject" maxLength={120} required/></label>
    <label>Message<textarea name="body" rows={4} maxLength={1000} required/></label>
    <button className="button button--primary" disabled={busy}>Queue synthetic newsletter</button>
    <Feedback status={status}/>
  </form>;
}

export function NotificationTestRetry({ marketId, id }: { marketId: MarketId; id: string }) {
  const { submit, busy, status } = useNotificationAction();
  return <div>
    <button className="button button--outline" type="button" disabled={busy}
      onClick={() => void submit({ action: "retry-test", marketId, id })}>Retry test</button>
    <Feedback status={status}/>
  </div>;
}
