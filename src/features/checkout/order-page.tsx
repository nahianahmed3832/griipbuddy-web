import 'server-only';
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
import { integratedCheckout, integratedOrder } from './integrated';

export async function OrderPage({ id, market }: { id: string; market: Market }) {
  if (!checkoutEnabled() && !integratedCheckout()) notFound();
  let order;
  try { order = integratedCheckout() ? await integratedOrder(id) : ownedOrder(orderId(id), (await checkoutOwners()).owners); }
  catch (error) {
    if (error instanceof CheckoutError && [401,404].includes(error.status)) notFound();
    throw error;
  }
  const orderMarket = marketForSegment((await catalogNavigation()).markets, order.market) ?? market;
  const money = (amount: number) => formatMinor(amount, orderMarket);
  return <div className="container interior checkout-order">
    <Link className="back-link" href={marketHref(market, '/products')}>Continue shopping</Link>
    <div className="interior-heading"><p className="eyebrow">TEST ORDER · {orderMarket.name}</p>
      <h1>Order {order.number}</h1><p>{statusLabels[order.status]} · {paymentLabels[order.payment]}</p>
    </div>
    <div className="bag-layout">
      <div className="checkout-order-main">
        <section><h2>Items ordered</h2>
          <ul className="checkout-order-items">{order.lines.map((line) => <li key={line.productId + ':' + line.variantId}>
            <div><strong>{line.title}</strong><small>{line.sku} · Quantity {line.quantity}</small></div><span>{money(line.unit * line.quantity)}</span>
          </li>)}</ul>
        </section>
        <section><h2>Order tracking</h2>
          {order.tracking && <p>Simulated tracking reference: <strong>{order.tracking}</strong></p>}
          <ol className="account-tracking">{order.history.map((event, index) =>
            <li key={index}>{statusLabels[event.status]} <small>{event.date.slice(0, 10)}</small></li>)}</ol>
          {order.returnRequest && <p>{order.returnRequest.kind === 'return' ? 'Return' : 'Refund'} request: {order.returnRequest.state}</p>}
        </section>
        <OrderActions id={order.id} status={order.status} method={order.method} returnState={order.returnRequest?.state} />
      </div>
      <section className="bag-summary" aria-label="Payment summary"><h2>Payment summary</h2>
        <dl className="bag-totals">
          <div><dt>Method</dt><dd>{methodDetails[order.method].label}</dd></div>
          <div><dt>Shipping</dt><dd>{money(order.shipping)}</dd></div>
          {order.discount > 0 && <div><dt>Savings</dt><dd>{money(order.discount)}</dd></div>}
          <div className="bag-estimate"><dt>Order total</dt><dd>{money(order.total)}</dd></div>
          {order.status === 'awaiting-review' && <div><dt>Advance under review</dt><dd>{money(order.advanceDue)}</dd></div>}
          <div><dt>Verified payment</dt><dd>{money(order.paid)}</dd></div>
          {['placed', 'dispatched'].includes(order.status) && order.total > order.paid &&
            <div><dt>Due on delivery</dt><dd>{money(order.total - order.paid)}</dd></div>}
          {order.refunded > 0 && <div><dt>Refunded</dt><dd>{money(order.refunded)}</dd></div>}
        </dl>
        {order.expiresAt && <p className="checkout-note">This reservation expires after 30 minutes if payment is not confirmed.</p>}
      </section>
    </div>
  </div>;
}
