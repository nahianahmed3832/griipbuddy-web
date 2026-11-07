import 'server-only';
import Link from 'next/link';
import { ArrowRight, Check, Clock, CircleAlert } from 'lucide-react';
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
  const confirmed = ['placed', 'dispatched', 'delivered'].includes(order.status);
  const blocked = ['cancelled', 'expired'].includes(order.status);
  const Icon = confirmed ? Check : blocked ? CircleAlert : Clock;
  const declined = order.failure === 'declined' || order.failure === 'receipt-rejected';
  const orderStatus = order.failure === 'declined' ? 'Payment declined'
    : order.failure === 'receipt-rejected' ? 'Receipt rejected' : statusLabels[order.status];
  return <div className="container interior checkout-order">
    <Link className="back-link" href={marketHref(market, '/products')}>Continue shopping</Link>
    <div className="interior-heading order-confirmation" data-tone={confirmed ? 'confirmed' : blocked ? 'attention' : 'pending'}>
      <span className="order-confirmation-icon"><Icon size={23} aria-hidden /></span>
      <div><p className="eyebrow">TEST ORDER · {orderMarket.name}</p>
        <h1>Order {order.number}</h1><p>{orderStatus} · {paymentLabels[order.payment]}</p>
        {declined && <p className="checkout-note">The stock hold was released. Add the items to your bag again to start a new checkout.</p>}
      </div>
      {integratedCheckout() && <Link className="button button-outline" href={marketHref(orderMarket, '/account/orders')}>
        Order history <ArrowRight size={16} aria-hidden/>
      </Link>}
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
            <li key={index}>{event.status === 'expired' ? orderStatus : statusLabels[event.status]} <small>
              <time dateTime={event.date}>{event.date.slice(0, 10)}</time></small></li>)}</ol>
          {order.returnRequest && <p>{order.returnRequest.kind === 'return' ? 'Return' : 'Refund'} request: {order.returnRequest.state}</p>}
        </section>
        <OrderActions id={order.id} status={order.status} method={order.method} returnState={order.returnRequest?.state} refundOnly={!integratedCheckout()}
          managed={order.revision !== undefined} canCancel={order.canCancel} />
      </div>
      <section className="bag-summary" aria-label="Payment summary"><h2>Payment summary</h2>
        <dl className="bag-totals">
          <div><dt>Method</dt><dd>{methodDetails[order.method]?.label ?? 'Awaiting payment method'}</dd></div>
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
