'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { methodDetails, type Method, type Status } from './contracts';

export function OrderActions({ id, status, method, returnState, refundOnly, managed, canCancel }: {
  id: string; status: Status; method: Method; returnState?: string; refundOnly: boolean; managed: boolean; canCancel?: boolean;
}) {
  const router = useRouter();
  const [working, setWorking] = useState('');
  const [feedback, setFeedback] = useState('');
  const [cancelPrompt, setCancelPrompt] = useState(false);
  async function run(action: string, data: Record<string, unknown> = {}) {
    if (working) return;
    setWorking(action);
    setFeedback('');
    try {
      const response = await fetch('/api/checkout/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: id, ...data }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Could not update your order.');
      setFeedback(action === 'return' ? 'Your request was submitted.' : action === 'cancel' ? 'Your order was cancelled.' : 'Simulation finished.');
      setCancelPrompt(false);
      router.refresh();
    } catch (error) { setFeedback(error instanceof Error ? error.message : 'Could not update your order.'); }
    finally { setWorking(''); }
  }
  function requestReturn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    void run('return', { kind: form.get('kind') ?? 'return', reason: form.get('reason') });
  }
  return <div className="checkout-actions">
    {!managed && status === 'awaiting-payment' && (method === 'stripe' || method === 'paypal') && <section>
      <h2>{methodDetails[method].label} simulation</h2>
      <p className="checkout-note">Choose a test outcome. No provider account or card details are needed.</p>
      <div className="checkout-buttons">
        <button className="button button-primary" disabled={!!working} onClick={() => void run('simulate', { outcome: 'captured' })}>Simulate approval</button>
        <button className="button button-outline" disabled={!!working} onClick={() => void run('simulate', { outcome: 'declined' })}>Simulate decline</button>
      </div>
    </section>}
    {(canCancel ?? ['placed', 'awaiting-payment', 'awaiting-review'].includes(status)) && <section>
      {cancelPrompt ? <>
        <p>Cancel this order and release its reserved items?</p>
        <div className="checkout-buttons">
          <button className="button button-outline" disabled={!!working} onClick={() => void run('cancel')}>Confirm cancellation</button>
          <button className="text-link" disabled={!!working} onClick={() => setCancelPrompt(false)}>Keep order</button>
        </div>
      </> : <button className="text-link" disabled={!!working} onClick={() => setCancelPrompt(true)}>Cancel order</button>}
    </section>}
    {status === 'delivered' && !returnState && <form className="checkout-form" onSubmit={requestReturn}>
      <fieldset disabled={!!working}><legend>{refundOnly ? 'Request a return or refund' : 'Request a return'}</legend>
        <div className="checkout-fields">
          {refundOnly && <label>Request type<select name="kind"><option value="return">Return items</option><option value="refund">Refund only</option></select></label>}
          <label className="checkout-wide">Reason<textarea name="reason" required maxLength={500} rows={3} /></label>
        </div>
        <button className="button button-outline" type="submit">Submit request</button>
      </fieldset>
    </form>}
    <p role="status" className="checkout-feedback">{working ? 'Updating order…' : feedback}</p>
  </div>;
}
