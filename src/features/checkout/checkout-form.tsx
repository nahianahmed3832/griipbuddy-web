'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, Banknote, CreditCard, Globe, LockKeyhole, ReceiptText, Wallet } from 'lucide-react';
import { marketHref, type Market } from '@/features/catalog/catalog';
import { formatMinor, lineKey, type CartLine, type CartQuote } from '@/features/cart/cart';
import { useBagCommands } from '@/features/cart/store';
import { quoteReview, type Method, type MethodOption } from './contracts';

const methodIcons = { cod: Banknote, manual: ReceiptText, paypal: Wallet, stripe: CreditCard };

async function requestKey(payload: unknown, receipt?: File) {
  const digest = async (bytes: ArrayBuffer | Uint8Array<ArrayBuffer>) =>
    Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const hash = await digest(new TextEncoder().encode(JSON.stringify(payload) + (receipt ? await digest(await receipt.arrayBuffer()) : '')));
  const storageKey = 'griipbuddy-checkout-attempt:' + hash;
  const key = sessionStorage.getItem(storageKey) ?? crypto.randomUUID();
  sessionStorage.setItem(storageKey, key);
  return { key, storageKey };
}

export function CheckoutForm({ market, methods, lines, quote, coupon, refreshQuote }: {
  market: Market; methods: MethodOption[]; lines: CartLine[]; quote?: CartQuote; coupon?: string; refreshQuote: () => void;
}) {
  const [chosen, setMethod] = useState<Method>(methods[0].id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const router = useRouter();
  const commands = useBagCommands();
  const selected = methods.find((entry) => entry.id === chosen) ?? methods[0];
  const method = selected.id;
  const total = quote?.estimatedTotal;
  const advance = selected?.advancePercent && total != null ? Math.ceil(total * selected.advancePercent / 100) : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!quote?.reviewReady || submitting.current) return;
    const fields = new FormData(event.currentTarget);
    const text = (key: string) => String(fields.get(key) ?? '');
    const file = fields.get('receipt');
    const receipt = file instanceof File && file.size ? file : undefined;
    if (method === 'manual' && (!receipt || receipt.size > 4 * 1024 * 1024)) {
      setError('Choose a JPEG or PNG receipt under 4 MB.'); return;
    }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const session = await fetch('/api/checkout/session', { method: 'POST' });
      if (!session.ok) throw new Error('Could not establish your checkout session.');
      const payload = {
        market: market.code, method, lines, coupon: quote.coupon?.status === 'applied' ? coupon : undefined, review: quoteReview(quote),
        delivery: { name: text('name'), phone: text('phone'), street: text('street'), city: text('city'), region: text('region'), postal: text('postal') },
        ...(method === 'manual' && { reference: text('reference'), paymentPhone: text('paymentPhone') }),
      };
      const { key, storageKey } = await requestKey(payload, receipt);
      let body: FormData | string = JSON.stringify({ ...payload, key });
      if (method === 'manual' && receipt) {
        body = new FormData();
        body.append('payload', JSON.stringify({ ...payload, key }));
        body.append('receipt', receipt);
      }
      const response = await fetch('/api/checkout/place', {
        method: 'POST', body, ...(typeof body === 'string' && { headers: { 'Content-Type': 'application/json' } }),
      });
      const result = await response.json();
      if (response.status === 409) { refreshQuote(); router.refresh(); }
      if (!response.ok || !result.order?.id) throw new Error(result.error ?? 'Checkout could not place your order.');
      for (const line of lines) await commands.remove(lineKey(line));
      if (coupon) await commands.coupon(market.code);
      sessionStorage.removeItem(storageKey);
      router.push(marketHref(market, '/order/' + result.order.id));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Checkout could not complete. Retry with the same details.');
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <form className="checkout-form" onSubmit={submit}>
    <div className="checkout-banner"><LockKeyhole size={18} aria-hidden /><div><strong>Test checkout</strong><span>Use sample details. Payments and delivery are simulated.</span></div></div>
    <fieldset disabled={busy}>
      <legend>Contact</legend>
      <div className="checkout-fields">
        <label className="checkout-wide">Delivery phone<input name="phone" type="tel" autoComplete="shipping tel" required maxLength={28} /></label>
      </div>
    </fieldset>
    <fieldset disabled={busy}>
      <legend>Delivery details</legend>
      <div className="checkout-fields">
        <div className="checkout-wide checkout-market"><Globe size={17} aria-hidden /><span>{market.name}</span><strong>{market.currency}</strong></div>
        <label className="checkout-wide">Recipient name<input name="name" autoComplete="shipping name" required maxLength={100} /></label>
        <label className="checkout-wide">Street address<input name="street" autoComplete="shipping address-line1" required maxLength={180} /></label>
        <label>City<input name="city" autoComplete="shipping address-level2" required maxLength={80} /></label>
        <label>{market.code === 'US' ? 'State' : market.code === 'BD' ? 'District' : 'State, province or region'}<input name="region" autoComplete="shipping address-level1" required maxLength={80} /></label>
        <label>{market.code === 'US' ? 'ZIP code' : 'Postal code (optional)'}<input name="postal" autoComplete="shipping postal-code" required={market.code === 'US'} maxLength={12} /></label>
      </div>
    </fieldset>
    <fieldset className="checkout-payment" disabled={busy}>
      <legend>Payment method</legend>
      {methods.map((option) => {
        const Icon = methodIcons[option.id];
        return <label className="checkout-method" key={option.id}>
        <input type="radio" name="method" value={option.id} checked={method === option.id} onChange={() => { setMethod(option.id); setError(''); }} />
          <span><strong>{option.label}</strong><small>{option.description}</small></span>
          <Icon className="checkout-method-icon" size={22} aria-hidden />
        </label>;
      })}
      {method === 'manual' && <div className="checkout-fields checkout-evidence">
        {advance !== undefined && total != null && <p className="checkout-wide">
          <strong>{formatMinor(advance, market)}</strong> advance · {formatMinor(total - advance, market)} due on delivery after review.
        </p>}
        <label>Payment phone<input name="paymentPhone" type="tel" required maxLength={28} /></label>
        <label>Transaction reference<input name="reference" required maxLength={64} /></label>
        <label className="checkout-wide">Payment receipt (JPEG or PNG, up to 4 MB)<input name="receipt" type="file" accept="image/png,image/jpeg" required /></label>
      </div>}
    </fieldset>
    {error && <p className="checkout-error" role="alert">{error}</p>}
    <button type="submit" className="button button-primary" disabled={!quote?.reviewReady || busy}>
      {busy ? 'Placing order…' : 'Place test order' + (total != null ? ' · ' + formatMinor(total, market) : '')} <ArrowRight size={17} aria-hidden />
    </button>
  </form>;
}
