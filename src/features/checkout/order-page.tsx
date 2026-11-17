import 'server-only';
import { ArrowLeft, ArrowUpRight, CircleHelp, PackageCheck, ReceiptText, Truck } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { formatMinor } from '@/features/cart/cart';
import { marketForSegment, marketHref, type Market } from '@/features/catalog/catalog';
import { catalogNavigation } from '@/features/catalog/data';
import { CheckoutError, methodDetails, paymentLabels, statusLabels } from './contracts';
import { checkoutEnabled } from './config';
import { checkoutOwners, orderId } from './http';
import { ownedOrder } from './orders';
import { OrderActions } from './order-actions';

export async function OrderPage({ id, market, fromAccount = false }: { id: string; market: Market; fromAccount?: boolean }) {
  if (!checkoutEnabled()) notFound();
  let order;
  try { order = ownedOrder(orderId(id), (await checkoutOwners()).owners); }
  catch (error) {
    if (error instanceof CheckoutError && error.status === 404) notFound();
    throw error;
  }
  const orderMarket = marketForSegment((await catalogNavigation()).markets, order.market) ?? market;
  const orderDisplay = { ...orderMarket, currency: order.currency };
  const money = (amount: number) => formatMinor(amount, orderDisplay);
  const dateFormat = new Intl.DateTimeFormat(orderMarket.locale, { dateStyle: 'medium', timeZone: 'UTC' });
  const dueOnDelivery = ['placed', 'dispatched'].includes(order.status) ? order.total - order.paid : 0;
  const backPath = fromAccount ? '/account/orders' : '/products';
  const backLabel = fromAccount ? 'All orders' : 'Continue shopping';
  return <div className="container interior checkout-order">
    <Link className="back-link checkout-order-back" href={marketHref(market, backPath)}><ArrowLeft size={16} aria-hidden />{backLabel}</Link>
    <header className="checkout-order-heading">
      <div>
        <p className="checkout-order-market">Test order · {orderMarket.name}</p>
        <h1>Order {order.number}</h1>
        <time dateTime={order.createdAt}>{dateFormat.format(new Date(order.createdAt))}</time>
      </div>
      <p className="checkout-order-status">{statusLabels[order.status]} · {paymentLabels[order.payment]}</p>
    </header>
    <div className="checkout-order-grid">
      <div className="checkout-order-main">
        <section className="checkout-order-card checkout-order-tracking">
          <h2><Truck size={20} aria-hidden />Order tracking</h2>
          {order.tracking && <p className="checkout-order-reference">Simulated tracking reference: <strong>{order.tracking}</strong></p>}
          <ol className="checkout-order-timeline" role="list">{order.history.map((event, index) =>
            <li key={index} aria-current={index === order.history.length - 1 ? 'step' : undefined}>
              <span>{statusLabels[event.status]}</span><time dateTime={event.date}>{dateFormat.format(new Date(event.date))}</time>
            </li>)}</ol>
          {order.returnRequest && <p className="checkout-order-reference">{order.returnRequest.kind === 'return' ? 'Return' : 'Refund'} request: <strong>{order.returnRequest.state}</strong></p>}
        </section>
        <section className="checkout-order-card checkout-order-line-card">
          <h2><PackageCheck size={20} aria-hidden />Items ordered</h2>
          <ul className="checkout-order-items">{order.lines.map((line) => <li key={line.productId + ':' + line.variantId}>
            <div><strong>{line.title}</strong><small>{line.sku} · Quantity {line.quantity}</small></div><span>{money(line.unit * line.quantity)}</span>
          </li>)}</ul>
        </section>
        <OrderActions id={order.id} status={order.status} method={order.method} returnState={order.returnRequest?.state} />
      </div>
      <div className="checkout-order-aside">
        <section className="checkout-order-card checkout-payment" aria-label="Payment summary">
          <h2><ReceiptText size={20} aria-hidden />Payment summary</h2>
          <dl className="bag-totals">
            <div><dt>Method</dt><dd>{methodDetails[order.method].label}</dd></div>
            <div><dt>Shipping</dt><dd>{money(order.shipping)}</dd></div>
            {order.discount > 0 && <div><dt>Savings</dt><dd>{money(order.discount)}</dd></div>}
            {order.status === 'awaiting-review' && <div><dt>Advance under review</dt><dd>{money(order.advanceDue)}</dd></div>}
            <div><dt>Verified payment</dt><dd>{money(order.paid)}</dd></div>
            {order.refunded > 0 && <div><dt>Refunded</dt><dd>{money(order.refunded)}</dd></div>}
            <div className="bag-estimate"><dt>Order total</dt><dd>{money(order.total)}</dd></div>
            {dueOnDelivery > 0 && <div className="checkout-payment-due"><dt>Amount due on delivery</dt><dd>{money(dueOnDelivery)}</dd></div>}
          </dl>
          {order.expiresAt && <p className="checkout-note">This reservation expires after 30 minutes if payment is not confirmed.</p>}
        </section>
        {fromAccount && <section className="checkout-order-card checkout-order-help">
          <h2><CircleHelp size={20} aria-hidden />Need help?</h2>
          <Link className="text-link" href={marketHref(market, '/account/returns')}>View returns & refunds<ArrowUpRight size={16} aria-hidden /></Link>
        </section>}
      </div>
    </div>
  </div>;
}
