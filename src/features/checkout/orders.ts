import 'server-only';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { catalogNavigation } from '@/features/catalog/data';
import { marketForSegment } from '@/features/catalog/catalog';
import { lineKey, maxCartLines, parseCoupon, parseLine, type CartLine } from '@/features/cart/cart';
import { quoteCart } from '@/features/cart/quote';
import { methodsFor } from './config';
import { CheckoutError, quoteReview, type CheckoutOrder, type Delivery, type Online } from './contracts';
import { checkoutDb, claimReference, mark, moveStock, newOrderId, orderRecord, releaseExpired, saveOrder, transaction } from './ledger';

export const receiptLimit = 4 * 1024 * 1024;
const holdDuration = 30 * 60 * 1000;
const hash = (input: string | Buffer) => createHash('sha256').update(input).digest('hex');

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new CheckoutError(400, 'Invalid checkout request.');
  return value as Record<string, unknown>;
}

function field(value: unknown, max: number, message: string, optional = false) {
  const text = typeof value === 'string' ? value.trim() : '';
  if ((!optional && !text) || text.length > max || /[\u0000-\u001f\u007f]/.test(text)) throw new CheckoutError(400, message);
  return text;
}

function phone(value: unknown) {
  const raw = field(value, 28, 'Enter a valid phone number.');
  const number = raw.replace(/[ ().-]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(number)) throw new CheckoutError(400, 'Enter a valid phone number.');
  return number;
}

function deliveryDetails(value: unknown, market: string): Delivery {
  const data = object(value);
  const postal = field(data.postal, 12, 'Enter a valid postal code.', market === 'BD');
  if (market === 'US' && !/^\d{5}(-\d{4})?$/.test(postal)) throw new CheckoutError(400, 'Enter a valid US ZIP code.');
  if (market === 'BD' && postal && !/^\d{4}$/.test(postal)) throw new CheckoutError(400, 'Enter a four-digit postal code.');
  return {
    name: field(data.name, 100, 'Enter the recipient name.'), phone: phone(data.phone),
    street: field(data.street, 180, 'Enter the delivery address.'), city: field(data.city, 80, 'Enter the delivery city.'),
    region: field(data.region, 80, 'Enter the state or district.'), postal,
  };
}

async function safeReceipt(file?: File) {
  if (!file || !['image/jpeg', 'image/png'].includes(file.type) || !file.size || file.size > receiptLimit) {
    throw new CheckoutError(400, 'Upload a JPEG or PNG receipt under 4 MB.');
  }
  const input = Buffer.from(await file.arrayBuffer());
  try {
    const signature = file.type === 'image/jpeg' ? 'ffd8ff' : '89504e470d0a1a0a';
    if (!input.subarray(0, signature.length / 2).equals(Buffer.from(signature, 'hex'))) throw new Error();
    const pipeline = sharp(input, { limitInputPixels: 12_000_000, failOn: 'warning' });
    const meta = await pipeline.metadata();
    if ((file.type === 'image/jpeg' ? 'jpeg' : 'png') !== meta.format || !meta.width || !meta.height
      || (meta.pages ?? 1) !== 1) throw new Error();
    // Decode and rebuild a static image. Original bytes, names and metadata are never kept.
    return { originalHash: hash(input), image: await pipeline.rotate().resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#fff' }).jpeg({ quality: 87 }).toBuffer() };
  } catch {
    throw new CheckoutError(400, 'The receipt could not be read as a complete JPEG or PNG.');
  }
}

export function publicOrder(order: CheckoutOrder) {
  const { id, number, createdAt, market, currency, total, shipping, discount, method, lines, status, payment, paid,
    advanceDue, refunded, expiresAt, history, tracking, returnRequest } = order;
  return { id, number, createdAt, market, currency, total, shipping, discount, method, lines, status, payment, paid,
    advanceDue, refunded, expiresAt, history, tracking, returnState: returnRequest?.state };
}

export async function placeOrder(owner: string, data: Record<string, unknown>, file?: File) {
  const idem = field(data.key, 64, 'Missing checkout request key.');
  if (!/^[\da-f-]{36}$/i.test(idem)) throw new CheckoutError(400, 'Invalid checkout request key.');
  const market = marketForSegment((await catalogNavigation()).markets, field(data.market, 4, 'Choose a market.'));
  const method = market && methodsFor(market.code).find((option) => option.id === data.method);
  if (!market || !method) throw new CheckoutError(409, 'This payment method is unavailable in your delivery market.');
  const delivery = deliveryDetails(data.delivery, market.code);
  const coupon = parseCoupon(data.coupon);
  if (data.coupon !== undefined && !coupon) throw new CheckoutError(400, 'Enter a valid coupon.');
  if (!Array.isArray(data.lines) || !data.lines.length || data.lines.length > maxCartLines) throw new CheckoutError(400, 'Check the items in your bag.');
  const lines = data.lines.flatMap((item) => {
    const line = parseLine(item);
    return line ? [{ productId: line.productId, variantId: line.variantId, slug: line.slug, quantity: line.quantity }] : [];
  }) satisfies CartLine[];
  if (lines.length !== data.lines.length || new Set(lines.map(lineKey)).size !== lines.length) {
    throw new CheckoutError(400, 'Use one valid quantity per product variant.');
  }
  const review = object(data.review);
  const manual = method.id === 'manual' ? {
    reference: field(data.reference, 64, 'Enter your transaction reference.').toUpperCase(),
    phone: phone(data.paymentPhone),
    receipt: await safeReceipt(file),
  } : undefined;
  if (manual && !/^[A-Z\d][A-Z\d-]{3,63}$/.test(manual.reference)) throw new CheckoutError(400, 'Enter a valid transaction reference.');
  if (!manual && file) throw new CheckoutError(400, 'Receipts are accepted for advance payments only.');

  const fingerprint = hash(JSON.stringify({ market: market.code, method: method.id, delivery, coupon, lines, review,
    reference: manual?.reference, phone: manual?.phone, receipt: manual?.receipt.originalHash }));
  releaseExpired();
  const database = checkoutDb();
  const prior = database.prepare('SELECT document, fingerprint FROM orders WHERE owner=? AND idem=?');
  const existing = () => {
    const row = prior.get(owner, idem) as { document: string; fingerprint: string } | undefined;
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint) throw new CheckoutError(409, 'This request was already used with different details.');
    return { order: publicOrder(JSON.parse(row.document)), replay: true };
  };
  const cached = existing();
  if (cached) return cached;

  const quote = await quoteCart(market, lines, coupon);
  if (!quote.reviewReady || quote.estimatedTotal === null || quote.shipping.status !== 'estimated'
    || JSON.stringify(quoteReview(quote)) !== JSON.stringify(review)) {
    const replay = existing();
    if (replay) return replay;
    throw new CheckoutError(409, 'Prices, shipping or availability changed. Review your bag and try again.');
  }
  const now = new Date();
  const id = newOrderId();
  const order: CheckoutOrder = {
    id, number: 'GB-' + id.replaceAll('-', '').slice(0, 12).toUpperCase(), createdAt: now.toISOString(),
    market: market.code, currency: market.currency, total: quote.estimatedTotal, shipping: quote.shipping.amount,
    discount: quote.saleDiscount + quote.couponDiscount, method: method.id, delivery,
    lines: quote.lines.map(({ productId, variantId, slug, title, sku, quantity, unit }) =>
      ({ productId, variantId, slug, title: title!, sku: sku!, quantity, unit: unit! })),
    status: method.id === 'cod' ? 'placed' : manual ? 'awaiting-review' : 'awaiting-payment',
    payment: method.id === 'cod' ? 'due-on-delivery' : manual ? 'review' : 'pending',
    paid: 0, advanceDue: manual ? Math.ceil(quote.estimatedTotal * method.advancePercent! / 100) : 0, refunded: 0,
    expiresAt: method.id === 'cod' ? null : now.getTime() + holdDuration,
    history: [],
    manualPhone: manual?.phone, manualReference: manual?.reference,
    providerAttempt: method.id === 'stripe' ? 'cs_test_' + id : method.id === 'paypal' ? 'PAYPAL-SIM-' + id : undefined,
  };
  mark(order, order.status);

  return transaction((db) => {
    const replay = existing();
    if (replay) return replay;
    const reserve = db.prepare('UPDATE stock SET held=held+? WHERE product=? AND variant=? AND on_hand-held>=?');
    for (const line of order.lines) {
      if (reserve.run(line.quantity, line.productId, line.variantId, line.quantity).changes !== 1) {
        throw new CheckoutError(409, 'An item just sold out. Review your bag and try again.');
      }
    }
    db.prepare('INSERT INTO orders(id,owner,idem,fingerprint,expiry,document) VALUES(?,?,?,?,?,?)')
      .run(order.id, owner, idem, fingerprint, order.expiresAt, JSON.stringify(order));
    if (manual) {
      claimReference(db, 'manual', manual.reference, order.id);
      db.prepare('INSERT INTO receipts(id,image) VALUES(?,?)').run(order.id, manual.receipt.image);
    }
    return { order: publicOrder(order), replay: false };
  });
}

export function ownedOrder(id: string, owners: string[]) {
  releaseExpired();
  const record = orderRecord(checkoutDb(), id);
  if (!owners.includes(record.owner)) throw new CheckoutError(404, 'Order not found.');
  return record.order;
}

export function customerOrders(owner: string) {
  releaseExpired();
  return (checkoutDb().prepare('SELECT document FROM orders WHERE owner=? ORDER BY rowid DESC').all(owner) as { document: string }[])
    .map((row) => JSON.parse(row.document) as CheckoutOrder);
}

function cancel(db: Parameters<typeof moveStock>[0], order: CheckoutOrder, failed = false) {
  if (order.status === 'cancelled') return;
  if (!['placed', 'awaiting-payment', 'awaiting-review'].includes(order.status)) {
    throw new CheckoutError(409, 'This order can no longer be cancelled.');
  }
  moveStock(db, order, 'release');
  order.expiresAt = null;
  order.payment = order.paid > 0 ? 'refund-pending' : failed ? 'failed' : 'void';
  mark(order, 'cancelled');
}

export function buyerAction(id: string, owners: string[], action: 'cancel' | 'return', data: Record<string, unknown>) {
  releaseExpired();
  return transaction((db) => {
    const { order, owner } = orderRecord(db, id);
    if (!owners.includes(owner)) throw new CheckoutError(404, 'Order not found.');
    if (action === 'cancel') cancel(db, order);
    else {
      const { kind } = data;
      if (order.status !== 'delivered' || (kind !== 'return' && kind !== 'refund')) {
        throw new CheckoutError(409, 'Select a delivered order.');
      }
      const reason = field(data.reason, 500, 'Tell us why you are making this request.');
      if (order.returnRequest) {
        if (order.returnRequest.kind !== kind || order.returnRequest.reason !== reason) throw new CheckoutError(409, 'A request already exists.');
      } else {
        order.returnRequest = { kind, reason, date: new Date().toISOString(), state: 'requested' };
      }
    }
    saveOrder(db, order);
    return publicOrder(order);
  });
}

export type ProviderEvent = { id: string; orderId: string; attempt: string; transaction: string; outcome: 'captured' | 'declined'; total: number; currency: string };

export function providerEvent(provider: Online, event: ProviderEvent) {
  releaseExpired();
  return transaction((db) => {
    const digest = hash(JSON.stringify(event));
    const seen = db.prepare('SELECT order_id,hash FROM payment_events WHERE provider=? AND id=?').get(provider, event.id) as
      { order_id: string; hash: string } | undefined;
    const { order } = orderRecord(db, event.orderId);
    if (seen && (seen.order_id !== order.id || seen.hash !== digest)) throw new CheckoutError(409, 'Conflicting payment event.');
    if (seen) return publicOrder(order);
    if (order.method !== provider || order.providerAttempt !== event.attempt || order.total !== event.total || order.currency !== event.currency) {
      throw new CheckoutError(409, 'Payment does not match the order.');
    }
    if (order.status === 'awaiting-payment') {
      claimReference(db, provider, event.transaction, order.id);
      order.transaction = event.transaction;
      if (event.outcome === 'captured') {
        order.paid = event.total;
        order.payment = 'paid';
        order.expiresAt = null;
        mark(order, 'placed');
      } else cancel(db, order, true);
      saveOrder(db, order);
    } else if (!(order.transaction === event.transaction &&
      ((event.outcome === 'captured' && order.paid === order.total) || (event.outcome === 'declined' && order.payment === 'failed')))) {
      throw new CheckoutError(409, 'This payment is no longer expected. Reconcile it before fulfillment.');
    }
    db.prepare('INSERT INTO payment_events(provider,id,order_id,hash) VALUES(?,?,?,?)').run(provider, event.id, order.id, digest);
    return publicOrder(order);
  });
}

export function operatorAction(id: string, action: unknown, data: Record<string, unknown>) {
  releaseExpired();
  return transaction((db) => {
    const { order } = orderRecord(db, id);
    const matches = (amount: number) => data.amount === amount && data.currency === order.currency;
    const matchesAdvance = () => Boolean(order.manualReference && data.reference === order.manualReference && matches(order.advanceDue));
    if (action === 'approve-receipt' && order.status === 'awaiting-review' && matchesAdvance()) {
      if (!db.prepare('SELECT 1 FROM receipts WHERE id=?').get(id)) throw new CheckoutError(409, 'Receipt is missing.');
      order.paid = order.advanceDue;
      order.payment = order.paid === order.total ? 'paid' : 'advance-verified';
      order.expiresAt = null;
      mark(order, 'placed');
    } else if (action === 'approve-receipt' && order.method === 'manual' && order.paid >= order.advanceDue && matchesAdvance()) {
      return publicOrder(order);
    } else if (action === 'reject-receipt' && (order.status === 'awaiting-review' || order.method === 'manual' && order.payment === 'failed')) {
      cancel(db, order, true);
    } else if (action === 'dispatch' && order.status === 'placed') {
      moveStock(db, order, 'dispatch');
      order.tracking = 'SIM-' + order.number;
      mark(order, 'dispatched');
    } else if (action === 'dispatch' && order.tracking) {
      return publicOrder(order);
    } else if (action === 'deliver' && order.collectedOnDelivery !== undefined && matches(order.collectedOnDelivery)) {
      return publicOrder(order);
    } else if (action === 'deliver' && order.status === 'dispatched' && matches(order.total - order.paid)) {
      order.collectedOnDelivery = order.total - order.paid;
      order.paid = order.total;
      order.payment = 'paid';
      mark(order, 'delivered');
    } else if (action === 'accept-return' && order.status === 'delivered' && order.returnRequest?.state === 'requested') {
      order.returnRequest.state = 'accepted';
      if (order.returnRequest.kind === 'return') {
        moveStock(db, order, 'return');
        mark(order, 'returned');
      }
      order.payment = order.paid ? 'refund-pending' : 'void';
    } else if (action === 'accept-return' && order.returnRequest?.state === 'accepted') {
      return publicOrder(order);
    } else if (action === 'refund' && (order.payment === 'refund-pending' || order.payment === 'refunded') && matches(order.paid)) {
      const reference = field(data.reference, 64, 'Enter the simulated refund reference.');
      if (order.payment === 'refunded') {
        if (!db.prepare("SELECT 1 FROM payment_refs WHERE kind='refund' AND ref=? AND order_id=?").get(reference, id)) {
          throw new CheckoutError(409, 'This order has a different refund reference.');
        }
        return publicOrder(order);
      }
      claimReference(db, 'refund', reference, id);
      order.refunded = order.paid;
      order.payment = 'refunded';
    } else {
      throw new CheckoutError(409, 'This operation does not match the order state, currency or amount.');
    }
    saveOrder(db, order);
    return publicOrder(order);
  });
}

export function privateReceipt(id: string) {
  const database = checkoutDb();
  const result = database.prepare('SELECT image FROM receipts WHERE id=?').get(id) as { image: Buffer } | undefined;
  if (!result) throw new CheckoutError(404, 'Receipt not found.');
  const { order } = orderRecord(database, id);
  return { ...result, phone: order.manualPhone!, reference: order.manualReference! };
}
