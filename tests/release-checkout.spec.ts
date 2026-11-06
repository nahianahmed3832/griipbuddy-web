import { createHash, createHmac, randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { expect, test, type APIRequestContext, type APIResponse } from '@playwright/test';
import { quoteReview, type Method } from '../src/features/checkout/contracts';
import type { CartQuote } from '../src/features/cart/cart';

const caseLine = { productId: 'fixture-form-case', variantId: 'form-case-std', slug: 'form-case', quantity: 1 };
const bagLine = { productId: 'fixture-arc-bag', variantId: 'arc-bag-espresso', slug: 'arc-bag', quantity: 1 };
const peer = () => process.env.GRIIPBUDDY_E2E_PEER!;
const operatorHeaders = () => ({ Authorization: 'Bearer ' + process.env.GRIIPBUDDY_E2E_OPERATOR });
const delivery = { name: 'Test Recipient', phone: '2025550117', street: '123 Fixture Avenue', city: 'Seattle', region: 'WA', postal: '98101' };
const receipt = () => sharp({ create: { width: 20, height: 12, channels: 3, background: 'white' } }).png().toBuffer();
type Payload = Awaited<ReturnType<typeof draft>>;

async function result(response: APIResponse, status: number) {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

async function draft(client: APIRequestContext, method: Method, lines = [caseLine], market = method === 'manual' ? 'BD' : 'US', coupon?: string) {
  await result(await client.post('/api/checkout/session'), 200);
  const quote: CartQuote = await result(await client.post('/api/cart/quote', { data: { market, lines, coupon } }), 200);
  expect(quote.reviewReady, JSON.stringify(quote)).toBe(true);
  return {
    key: randomUUID(), method, market, lines, coupon, review: quoteReview(quote),
    delivery: market === 'BD' ? { ...delivery, city: 'Dhaka', region: 'Dhaka', postal: '1207' } : delivery,
    ...(method === 'manual' && { reference: 'RECEIPT-' + randomUUID(), paymentPhone: '01000000021' }),
  };
}

function place(client: APIRequestContext, data: Payload, bytes?: Buffer, base = '', mimeType = 'image/png') {
  return client.post(base + '/api/checkout/place', bytes ? {
    multipart: { payload: JSON.stringify(data), receipt: { name: 'proof.png', mimeType, buffer: bytes } },
  } : { data });
}

const cancel = (client: APIRequestContext, id: string) => client.post('/api/checkout/cancel', { data: { orderId: id } });
const operate = (client: APIRequestContext, orderId: string, action: string, fields = {}) =>
  client.post('/api/checkout/operator', { headers: operatorHeaders(), data: { orderId, action, ...fields } });

async function callback(client: APIRequestContext, provider: 'paypal' | 'stripe', event: {
  id: string; orderId: string; transaction: string; outcome: string; total: number; currency: string; attempt?: string; live?: boolean;
}, age = 0, altered = false) {
  const paid = event.outcome === 'captured';
  const raw = JSON.stringify(provider === 'stripe' ? {
    id: event.id, livemode: event.live ?? false, type: paid ? 'checkout.session.completed' : 'checkout.session.async_payment_failed',
    data: { object: { id: event.attempt ?? 'cs_test_' + event.orderId, object: 'checkout.session', client_reference_id: event.orderId,
      payment_intent: event.transaction, payment_status: paid ? 'paid' : 'unpaid', amount_total: event.total, currency: event.currency.toLowerCase() } },
  } : {
    id: event.id, event_type: paid ? 'PAYMENT.CAPTURE.COMPLETED' : 'PAYMENT.CAPTURE.DENIED',
    resource: { id: event.transaction, status: paid ? 'COMPLETED' : 'DECLINED',
      amount: { currency_code: event.currency, value: (event.total / 100).toFixed(2) },
      supplementary_data: { related_ids: { order_id: event.attempt ?? 'PAYPAL-SIM-' + event.orderId } } },
  });
  const time = Math.floor(Date.now() / 1000) - age;
  const mac = createHmac('sha256', process.env[provider === 'stripe' ? 'GRIIPBUDDY_E2E_STRIPE' : 'GRIIPBUDDY_E2E_PAYPAL']!)
    .update((provider === 'paypal' ? 'paypal.' : '') + time + '.' + raw).digest('hex');
  return client.post('/api/checkout/webhook/' + provider, {
    headers: { 'Content-Type': 'application/json', [provider === 'stripe' ? 'stripe-signature' : 'x-griipbuddy-sim-signature']: 't=' + time + ',v1=' + mac },
    data: raw + (altered ? ' ' : ''),
  });
}

test('last-unit concurrency is atomic for every payment method across separate server processes', async ({ playwright, baseURL, request }) => {
  const left = await playwright.request.newContext({ baseURL });
  const right = await playwright.request.newContext({ baseURL });
  try {
    for (const method of ['cod', 'manual', 'paypal', 'stripe'] as const) {
      const seed = await draft(request, 'cod', [{ ...caseLine, quantity: 7 }]);
      const hold = (await result(await place(request, seed), 201)).order;
      const first = await draft(left, method);
      const second = await draft(right, method);
      const image = method === 'manual' ? await receipt() : undefined;
      const responses = await Promise.all([place(left, first, image), place(right, second, image, peer())]);
      expect(responses.map((response) => response.status()).sort()).toEqual([201, 409]);
      const winner = responses.findIndex((response) => response.status() === 201);
      const { order } = await responses[winner].json();
      const who = winner === 0 ? left : right;
      const replay = await result(await place(who, winner === 0 ? first : second, image, peer()), 200);
      expect(replay.order.id).toBe(order.id);
      await result(await cancel(who, order.id), 200);
      await result(await cancel(who, order.id), 200);
      await result(await cancel(request, hold.id), 200);
    }
  } finally { await left.dispose(); await right.dispose(); }
});

test('mixed providers share one hold, stale quotes fail, and same-key races create one order', async ({ playwright, baseURL, request }) => {
  const rival = await playwright.request.newContext({ baseURL });
  try {
    const bad = await draft(request, 'cod');
    await result(await place(request, { ...bad, review: { ...bad.review, total: 1 } }), 409);
    await result(await place(request, { ...bad, market: 'INTL' }), 409);
    await result(await place(request, { ...bad, market: 'BD', method: 'paypal' }), 409);
    await result(await request.post('/api/checkout/place', { headers: { Origin: 'https://cross-site.invalid' }, data: bad }), 403);
    const seed = await draft(request, 'cod', [{ ...caseLine, quantity: 7 }]);
    const hold = (await result(await place(request, seed), 201)).order;
    const first = await draft(request, 'paypal', [bagLine, caseLine]);
    const second = await draft(rival, 'cod');
    const responses = await Promise.all([place(request, first), place(rival, second, undefined, peer())]);
    expect(responses.map((response) => response.status()).sort()).toEqual([201, 409]);
    const winner = responses.findIndex((response) => response.status() === 201);
    await result(await cancel(winner ? rival : request, (await responses[winner].json()).order.id), 200);
    await result(await cancel(request, hold.id), 200);
    const same = await draft(request, 'stripe');
    const pair = await Promise.all([place(request, same), place(request, same, undefined, peer())]);
    expect(pair.map((response) => response.status()).sort()).toEqual([200, 201]);
    const ids = await Promise.all(pair.map(async (response) => (await response.json()).order.id));
    expect(ids[0]).toBe(ids[1]);
    await result(await place(request, { ...same, delivery: { ...same.delivery, name: 'Different name' } }), 409);
    await result(await cancel(request, ids[0]), 200);
  } finally { await rival.dispose(); }
});

test('manual advance requires safe private evidence and an operator amount/currency match', async ({ playwright, baseURL, request }) => {
  const draftOrder = await draft(request, 'manual', [caseLine], 'BD', 'PREVIEW10');
  const image = await receipt();
  await result(await place(request, draftOrder), 400);
  await result(await place(request, draftOrder, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), 400);
  await result(await place(request, draftOrder, image.subarray(0, 35)), 400);
  await result(await place(request, draftOrder, image, '', 'image/svg+xml'), 400);
  await result(await place(request, draftOrder, Buffer.alloc(5 * 1024 * 1024)), 413);
  const { order } = await result(await place(request, draftOrder, image), 201);
  expect(order).toMatchObject({ status: 'awaiting-review', payment: 'review', paid: 0, advanceDue: Math.ceil(order.total / 5), currency: 'BDT' });
  expect(order).not.toHaveProperty('manualReference');
  await result(await place(request, { ...draftOrder, key: randomUUID() }, image), 409);
  await result(await request.get('/api/checkout/receipt?id=' + order.id), 403);
  await result(await request.post('/api/checkout/operator', { data: { action: 'approve-receipt', orderId: order.id } }), 403);
  const stranger = await playwright.request.newContext({ baseURL });
  try {
    await stranger.post('/api/checkout/session');
    await result(await stranger.get('/api/checkout/order?id=' + order.id), 404);
    await result(await cancel(stranger, order.id), 404);
  } finally { await stranger.dispose(); }
  const privateFile = await request.get('/api/checkout/receipt?id=' + order.id, { headers: operatorHeaders() });
  expect(privateFile.status()).toBe(200);
  expect(privateFile.headers()['cache-control']).toBe('private, no-store');
  expect(privateFile.headers()['content-disposition']).toMatch(/^attachment/);
  expect(await sharp(await privateFile.body()).metadata()).toMatchObject({ format: 'jpeg', width: 20, height: 12 });
  await result(await operate(request, order.id, 'dispatch'), 409);
  const reference = draftOrder.reference?.toUpperCase();
  await result(await operate(request, order.id, 'approve-receipt', { amount: order.advanceDue, currency: 'BDT', reference: 'INCORRECT' }), 409);
  await result(await operate(request, order.id, 'approve-receipt', { amount: order.advanceDue, currency: 'USD', reference }), 409);
  await result(await operate(request, order.id, 'approve-receipt', { amount: order.total, currency: 'BDT', reference }), 409);
  const approved = (await result(await operate(request, order.id, 'approve-receipt', { amount: order.advanceDue, currency: 'BDT', reference }), 200)).order;
  expect(approved).toMatchObject({ paid: order.advanceDue, payment: 'advance-verified', status: 'placed' });
  await result(await operate(request, order.id, 'dispatch'), 200);
  const due = order.total - order.advanceDue;
  await result(await operate(request, order.id, 'deliver', { amount: due - 1, currency: 'BDT' }), 409);
  expect((await result(await operate(request, order.id, 'deliver', { amount: due, currency: 'BDT' }), 200)).order)
    .toMatchObject({ payment: 'paid', paid: order.total, status: 'delivered' });
});

test('signed callbacks bind method, amount, currency, order and reference; declines and expiry release stock', async ({ request }) => {
  for (const provider of ['stripe', 'paypal'] as const) {
    const { order } = await result(await place(request, await draft(request, provider)), 201);
    const event = { id: randomUUID(), orderId: order.id, transaction: randomUUID(), outcome: 'captured', total: order.total, currency: 'USD' };
    await result(await request.post('/api/checkout/webhook/' + provider, { data: event }), 401);
    await result(await callback(request, provider, event, 600), 401);
    await result(await callback(request, provider, event, 0, true), 401);
    await result(await callback(request, provider === 'stripe' ? 'paypal' : 'stripe', event), 409);
    await result(await callback(request, provider, { ...event, total: event.total + 1 }), 409);
    if (provider === 'stripe') {
      await result(await callback(request, provider, { ...event, live: true }), 400);
      await result(await callback(request, provider, { ...event, attempt: 'cs_test_other_order' }), 409);
    }
    await result(await callback(request, provider, { ...event, currency: 'BDT' }), 409);
    await result(await callback(request, provider, event), 200);
    await result(await callback(request, provider, event), 200);
    await result(await callback(request, provider, { ...event, id: randomUUID() }), 200);
    await result(await callback(request, provider, { ...event, transaction: randomUUID() }), 409);
    const paid = (await result(await request.get('/api/checkout/order?id=' + order.id), 200)).order;
    expect(paid).toMatchObject({ paid: order.total, payment: 'paid', status: 'placed' });
    expect(paid.history).toHaveLength(2);
    const another = (await result(await place(request, await draft(request, provider)), 201)).order;
    await result(await callback(request, provider, { ...event, id: randomUUID(), orderId: another.id }), 409);
    await result(await callback(request, provider, { ...event, id: randomUUID(), orderId: another.id, transaction: randomUUID(), outcome: 'declined' }), 200);
    expect((await result(await request.get('/api/checkout/order?id=' + another.id), 200)).order)
      .toMatchObject({ status: 'cancelled', payment: 'failed', paid: 0 });
    expect((await result(await cancel(request, order.id), 200)).order).toMatchObject({ payment: 'refund-pending' });
    const refund = { amount: order.total, currency: 'USD', reference: randomUUID() };
    await result(await operate(request, order.id, 'refund', refund), 200);
    await result(await operate(request, order.id, 'refund', refund), 200);
    await result(await operate(request, order.id, 'refund', { ...refund, reference: randomUUID() }), 409);
  }
  const { order } = await result(await place(request, await draft(request, 'stripe')), 201);
  const database = new Database(join(process.env.GRIIPBUDDY_E2E_DIR!, 'checkout.sqlite'));
  try { database.prepare('UPDATE orders SET expiry=? WHERE id=?').run(Date.now() - 1, order.id); }
  finally { database.close(); }
  expect((await result(await request.get('/api/checkout/order?id=' + order.id), 200)).order).toMatchObject({ status: 'expired', paid: 0 });
  await result(await callback(request, 'stripe', { id: randomUUID(), orderId: order.id, transaction: randomUUID(),
    outcome: 'captured', total: order.total, currency: 'USD' }), 409);
});

test('COD fulfillment, tracking, return restock and refund reconcile without duplicate mutations', async ({ request }) => {
  const stock = async () => (await result(await request.post('/api/cart/quote', { data: { market: 'US', lines: [caseLine] } }), 200)).lines[0].available;
  const before = await stock();
  const { order } = await result(await place(request, await draft(request, 'cod')), 201);
  expect(order).toMatchObject({ payment: 'due-on-delivery', paid: 0, status: 'placed' });
  expect(await stock()).toBe(before - 1);
  await result(await operate(request, order.id, 'dispatch'), 200);
  await result(await operate(request, order.id, 'dispatch'), 200);
  expect(await stock()).toBe(before - 1);
  await result(await cancel(request, order.id), 409);
  const delivered = (await result(await operate(request, order.id, 'deliver', { amount: order.total, currency: 'USD' }), 200)).order;
  expect(delivered).toMatchObject({ status: 'delivered', payment: 'paid', tracking: expect.stringMatching(/^SIM-/) });
  expect((await result(await operate(request, order.id, 'deliver', { amount: order.total, currency: 'USD' }), 200)).order.history)
    .toEqual(delivered.history);
  const data = { orderId: order.id, kind: 'return', reason: 'Synthetic return test' };
  await result(await request.post('/api/checkout/return', { data }), 200);
  await result(await request.post('/api/checkout/return', { data }), 200);
  await result(await operate(request, order.id, 'accept-return'), 200);
  await result(await operate(request, order.id, 'accept-return'), 200);
  expect(await stock()).toBe(before);
  const refunded = (await result(await operate(request, order.id, 'refund', { amount: order.total, currency: 'USD', reference: randomUUID() }), 200)).order;
  expect(refunded).toMatchObject({ status: 'returned', payment: 'refunded', refunded: order.total });
  const report = await result(await request.get('/api/checkout/reconcile', { headers: operatorHeaders() }), 200);
  expect(report).toMatchObject({ ok: true, errors: [] });
  expect(report.orders).toBeGreaterThan(10);
  console.log('Synthetic order/inventory reconciliation:', JSON.stringify(report));
  await result(await request.get('/api/checkout/reconcile'), 403);
});

test('synthetic order, receipt and stock data survive an isolated consistent backup restore', async () => {
  const source = new Database(join(process.env.GRIIPBUDDY_E2E_DIR!, 'checkout.sqlite'), { readonly: true });
  const dir = mkdtempSync(join(tmpdir(), 'griipbuddy-checkout-restore-'));
  const copy = join(dir, 'checkout.sqlite');
  const summarize = (db: Database.Database) => Object.fromEntries(['orders', 'stock', 'receipts', 'payment_events', 'payment_refs'].map((table) => {
    const rows = db.prepare('SELECT * FROM ' + table + ' ORDER BY rowid').all();
    return [table, { count: rows.length, fingerprint: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }];
  }));
  try {
    await source.backup(copy);
    chmodSync(copy, 0o600);
    const restored = new Database(copy, { readonly: true });
    try {
      expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(restored.pragma('foreign_key_check')).toEqual([]);
      const audit = summarize(restored);
      expect(audit).toEqual(summarize(source));
      expect(audit.receipts.count).toBeGreaterThan(0);
      console.log('Synthetic checkout backup restore:', Object.fromEntries(Object.entries(audit).map(([table, row]) => [table, row.count])));
    } finally { restored.close(); }
  } finally {
    source.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkout rollback switch blocks new orders and preserves existing order and callback access', async ({ request }) => {
  const draftOrder = await draft(request, 'paypal', [bagLine]);
  const { order } = await result(await place(request, draftOrder), 201);
  const paused = process.env.GRIIPBUDDY_E2E_PAUSED!;
  await result(await place(request, { ...draftOrder, key: randomUUID() }, undefined, paused), 503);
  expect((await result(await request.get(paused + '/api/checkout/order?id=' + order.id), 200)).order.status).toBe('awaiting-payment');
  expect((await result(await request.post(paused + '/api/checkout/simulate', { data: { orderId: order.id, outcome: 'declined' } }), 200)).order)
    .toMatchObject({ status: 'cancelled', payment: 'failed', paid: 0 });
  expect((await result(await request.get('/api/checkout/order?id=' + order.id), 200)).order.status).toBe('cancelled');
});
