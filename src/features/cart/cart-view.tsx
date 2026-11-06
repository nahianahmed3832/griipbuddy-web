'use client';

import { ArrowRight, ImageIcon, Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useContext, useEffect, useState } from 'react';
import { marketHref, productHref, type Market } from '@/features/catalog/catalog';
import { CheckoutForm } from '@/features/checkout/checkout-form';
import type { MethodOption } from '@/features/checkout/contracts';
import { CartActions } from './actions';
import { formatMinor, lineKey, maxLineQuantity, parseCoupon, type CartLine, type CartQuote, type QuotedLine } from './cart';
import { useBagCommands, useCart } from './store';

async function requestQuote(payload: string, signal?: AbortSignal, preview?: 'approve' | 'decline') {
  const response = await fetch('/api/cart/quote', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: preview ? JSON.stringify({ ...JSON.parse(payload), preview }) : payload,
    signal,
  });
  if (!response.ok) throw new Error('Bag quote unavailable');
  return await response.json() as CartQuote;
}

function Quantity({ line, title }: { line: CartLine; title: string }) {
  const [edit, setEdit] = useState<{ quantity: number; value: string }>();
  const value = edit?.quantity === line.quantity ? edit.value : String(line.quantity);

  const commands = useBagCommands();
  function change(quantity: number) {
    if (line.quantity !== quantity) void commands.quantity(lineKey(line), quantity);
    setEdit(undefined);
  }

  function adjust(delta: number) {
    setEdit(undefined);
    void commands.adjust(lineKey(line), delta);
  }

  return <div className="bag-quantity">
    <button type="button" aria-label={'Decrease quantity for ' + title} disabled={line.quantity <= 1}
      onClick={() => adjust(-1)}><Minus size={15} aria-hidden /></button>
    <input type="number" min={1} max={maxLineQuantity} step={1} inputMode="numeric" value={value}
      aria-label={'Quantity for ' + title} onChange={(event) => setEdit({ quantity: line.quantity, value: event.target.value })}
      onBlur={() => change(Number(value))}
      onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
    <button type="button" aria-label={'Increase quantity for ' + title} disabled={line.quantity >= maxLineQuantity}
      onClick={() => adjust(1)}><Plus size={15} aria-hidden /></button>
  </div>;
}

function stockMessage(line: QuotedLine) {
  switch (line.status) {
    case 'unavailable': return 'Unavailable in this market';
    case 'unpriced': return 'Price unavailable in this market';
    case 'out': return 'Out of stock';
    case 'insufficient': return 'Only ' + line.available + ' available. Reduce quantity to continue.';
    case 'unknown': return 'Availability could not be verified';
    case 'ready': return '';
  }
}

function BagItem({ line, quoted, market, onNavigate, readonly }: {
  line: CartLine; quoted?: QuotedLine; market: Market; onNavigate?: () => void; readonly: boolean;
}) {
  const commands = useBagCommands();
  const title = quoted?.title || line.label || line.slug;
  const message = quoted ? stockMessage(quoted) : '';
  const href = productHref(market, line.slug) + '?variant=' + encodeURIComponent(line.variantId);
  return <li className="bag-item">
    <div className="bag-image">
      {quoted?.image ? <Image src={quoted.image} alt="" fill sizes="96px" unoptimized={quoted.image.startsWith('https://')}
        referrerPolicy="no-referrer" /> : <ImageIcon aria-hidden size={23} />}
    </div>
    <div className="bag-item-details">
      <h3>{quoted?.title ? <Link href={href} onClick={onNavigate}>{title}</Link> : title}</h3>
      {quoted?.options?.length ? <p className="bag-options">{quoted.options.join(' · ')}</p> : null}
      {quoted?.sku && <p className="bag-sku">SKU {quoted.sku}</p>}
      {quoted?.unit !== undefined && <p className="bag-unit">
        {formatMinor(quoted.unit, market)} each
        {quoted.regular !== undefined && quoted.regular > quoted.unit && <del>{formatMinor(quoted.regular, market)}</del>}
      </p>}
      {message && <p className="bag-line-error">{message}</p>}
      {readonly ? <p className="bag-sku">Quantity {line.quantity}</p> : <div className="bag-item-actions">
        <Quantity line={line} title={title} />
        <button type="button" className="bag-remove" aria-label={'Remove ' + title} onClick={() => void commands.remove(lineKey(line))}>
          <Trash2 size={15} aria-hidden /><span>Remove</span>
        </button>
      </div>}
    </div>
    {quoted?.lineTotal !== undefined && <p className="bag-line-total">{formatMinor(quoted.lineTotal, market)}</p>}
  </li>;
}

function Coupon({ market, code, coupon }: { market: Market; code?: string; coupon?: CartQuote['coupon'] }) {
  const commands = useBagCommands();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState('');
  const statuses = {
    applied: 'Coupon applied.',
    invalid: 'This coupon is invalid for the current market.',
    unavailable: 'Coupon validation is unavailable for this catalog.',
    'needs-items': 'Resolve the unavailable items to apply a coupon.',
  };
  return <div className="bag-coupon">
    <form onSubmit={(event) => {
      event.preventDefault();
      const next = parseCoupon(draft ?? code);
      if (!next) { setError('Enter a coupon code using letters, numbers, hyphens or underscores.'); return; }
      setError('');
      setDraft(null);
      void commands.coupon(market.code, next);
    }}>
      <label htmlFor="bag-coupon-code">Coupon code</label>
      <div>
        <input id="bag-coupon-code" value={draft ?? code ?? ''} maxLength={32} autoComplete="off"
          onChange={(event) => { setDraft(event.target.value); setError(''); }} />
        <button className="button button-outline" type="submit">Apply</button>
      </div>
    </form>
    {code && <button className="text-link" type="button" onClick={() => { setDraft(null); setError(''); void commands.coupon(market.code); }}>Remove coupon</button>}
    {(error || coupon) && <p role="status" className={coupon?.status === 'applied' && !error ? 'bag-coupon-ok' : 'bag-line-error'}>
      {error || (coupon && statuses[coupon.status])}
    </p>}
  </div>;
}

function Totals({ quote, market }: { quote: CartQuote; market: Market }) {
  const money = (amount: number) => formatMinor(amount, market);
  const issues = quote.lines.some((line) => line.status !== 'ready');
  const shipping = quote.shipping.status === 'estimated' ? money(quote.shipping.amount)
    : quote.shipping.status === 'destination-required' ? 'Choose a delivery country' : 'Shipping not configured';

  return <dl className="bag-totals">
    <div><dt>{issues ? 'Subtotal for available items' : 'Subtotal'}</dt><dd>{money(quote.subtotal)}</dd></div>
    {quote.saleDiscount > 0 && <div><dt>Sale savings</dt><dd>−{money(quote.saleDiscount)}</dd></div>}
    {quote.couponDiscount > 0 && <div><dt>Coupon discount</dt><dd>−{money(quote.couponDiscount)}</dd></div>}
    <div><dt>Merchandise</dt><dd>{money(quote.merchandise)}</dd></div>
    <div><dt>Estimated shipping</dt><dd>{shipping}</dd></div>
    <div className="bag-estimate"><dt>Estimated total before tax</dt><dd>{quote.estimatedTotal === null ? '—' : money(quote.estimatedTotal)}</dd></div>
  </dl>;
}

export function CartView({ market, view, onNavigate, methods, paused }: {
  market: Market; view: 'drawer' | 'page' | 'checkout'; onNavigate?: () => void; methods?: MethodOption[]; paused?: boolean;
}) {
  const { lines, coupon, hydrated } = useCart();
  const actions = useContext(CartActions);
  const commands = useBagCommands();
  const [attempt, setAttempt] = useState(0);
  const [reply, setReply] = useState<{ key: string; quote?: CartQuote }>();
  const [outcome, setOutcome] = useState<'approve' | 'decline'>('approve');
  const [simulation, setSimulation] = useState<{ key: string; text: string }>();
  const [pending, setPending] = useState<string>();
  const code = coupon?.market === market.code ? coupon.code : undefined;
  const payload = JSON.stringify({ market: market.code, lines, coupon: code });
  const requestKey = attempt + ':' + payload;
  const hasLines = lines.length > 0;
  const checkout = view === 'checkout';
  const checkoutEnabled = checkout && Boolean(methods?.length);
  const count = lines.reduce((total, line) => total + line.quantity, 0);

  useEffect(() => {
    if (!hasLines) return;
    const controller = new AbortController();
    requestQuote(payload, controller.signal).then((quote) => {
      if (!controller.signal.aborted) setReply({ key: requestKey, quote });
    }).catch(() => {
      if (!controller.signal.aborted) setReply({ key: requestKey });
    });
    return () => controller.abort();
  }, [hasLines, payload, requestKey]);

  if (!hydrated) return <p role="status" className="bag-loading">Loading your bag…</p>;
  if (!lines.length) return <div className="empty-state">
    <ShoppingBag aria-hidden /><h2>Your bag is empty</h2><p>Find something you love in the catalog.</p>
    <Link className="button button-primary" href={marketHref(market, '/products')} onClick={onNavigate}>Shop all <ArrowRight size={16} aria-hidden /></Link>
  </div>;

  const current = reply?.key === requestKey ? reply : undefined;
  const quote = current?.quote;
  const byKey = new Map(quote?.lines.map((line) => [lineKey(line), line]));
  const ready = quote?.reviewReady === true;
  const status = simulation?.key === requestKey ? simulation.text : '';
  const bagPath = marketHref(market, '/cart');
  const checkoutPath = marketHref(market, '/checkout');

  async function simulate() {
    if (!ready || !quote) return;
    setPending(requestKey);
    setSimulation(undefined);
    try {
      const next = await requestQuote(payload, undefined, outcome);
      setReply((previous) => previous?.key === requestKey ? { key: requestKey, quote: next } : previous);
      const unchanged = next.currency === quote.currency && next.estimatedTotal === quote.estimatedTotal
        && next.lines.every((line, index) => line.status === quote.lines[index]?.status && line.unit === quote.lines[index]?.unit);
      setSimulation({ key: requestKey, text: !next.reviewReady || !unchanged
        ? 'Your bag changed. Review the updated estimate.'
        : next.paymentPreview === 'approved' ? 'Simulated payment approved.' : 'Simulated payment declined.' });
    } catch {
      setSimulation({ key: requestKey, text: 'The simulation could not verify your bag. Try again.' });
    } finally {
      setPending((previous) => previous === requestKey ? undefined : previous);
    }
  }

  const items = <section className="bag-items" aria-label={checkout ? 'Items for review' : 'Bag items'}>
    <p className="bag-context">{count} {count === 1 ? 'item' : 'items'} · {market.name} · {market.currency}</p>
    <ul>{lines.map((line) => <BagItem key={lineKey(line)} line={line} quoted={byKey.get(lineKey(line))} market={market}
      onNavigate={onNavigate} readonly={checkout} />)}</ul>
    {checkout && <Link className="text-link" href={bagPath}>Edit shopping bag</Link>}
  </section>;

  return <div className={'bag-layout bag-' + view + (checkoutEnabled ? ' checkout-layout' : '')}>
    {checkoutEnabled ? <CheckoutForm market={market} methods={methods!} lines={lines} quote={quote} coupon={code} /> : items}
    <section className={checkoutEnabled ? "bag-summary checkout-totals" : "bag-summary"} aria-label="Bag summary">
      <h2>{checkout ? 'Checkout estimate' : 'Order summary'}</h2>
      {checkoutEnabled && items}
      {commands.error && <p role="status" className="bag-line-error">{commands.error}</p>}
      {!current ? <p role="status" className="bag-loading">Checking prices and availability…</p>
        : !quote ? <div className="bag-quote-error"><p role="status">Prices and stock could not be verified.</p>
          <button type="button" className="button button-outline" onClick={() => setAttempt(attempt + 1)}>Retry estimate</button></div>
          : <Totals quote={quote} market={market} />}
      {(view === 'page' || checkoutEnabled) && <Coupon market={market} code={code} coupon={quote?.coupon} />}
      {checkout && quote?.coupon && quote.coupon.status !== 'applied' && <p className="bag-line-error">Coupon {quote.coupon.code} is excluded from the estimate.</p>}
      {quote && !ready && <p className="bag-estimate-note">
        {quote.lines.some((line) => line.status !== 'ready') ? 'Update unavailable items before checkout review.'
          : 'Choose a country with configured shipping for a checkout estimate.'}
      </p>}
      {quote && quote.shipping.status !== 'estimated' && actions && <button className="text-link" type="button"
        onClick={(event) => actions.chooseMarket(event.currentTarget)}>Change delivery country</button>}
      <div className="bag-summary-actions">
        {view === 'drawer' && <Link className="button button-outline" href={bagPath} onClick={onNavigate}>View shopping bag</Link>}
        {!checkout && (ready
          ? <Link className="button button-primary" href={checkoutPath} onClick={onNavigate}>Review checkout <ArrowRight size={16} aria-hidden /></Link>
          : <button className="button button-primary" type="button" disabled>Review checkout</button>)}
        {checkout && paused && <p role="status">Test checkout is temporarily paused.</p>}
        {checkout && !checkoutEnabled && !paused && <div className="payment-preview">
          <p>Simulated payment</p>
          <label>Test outcome <select value={outcome} onChange={(event) => {
            setOutcome(event.target.value === 'decline' ? 'decline' : 'approve');
            setSimulation(undefined);
          }}>
            <option value="approve">Approval</option><option value="decline">Decline</option>
          </select></label>
          <button className="button button-primary" type="button" onClick={() => void simulate()} disabled={!ready || pending === requestKey}>
            {pending === requestKey ? 'Rechecking bag…' : 'Run payment simulation'}
          </button>
          {status && <p role="status">{status}</p>}
        </div>}
      </div>
    </section>
  </div>;
}
