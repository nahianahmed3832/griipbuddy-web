import 'server-only';
import { createHmac } from 'node:crypto';
import { currencyScale } from '@/features/cart/cart';
import { CheckoutError, type CheckoutOrder, type Online } from './contracts';
import { matchesSecret, orderId, parseJson } from './http';
import { object, providerEvent, type ProviderEvent } from './orders';

const online = new Set(['stripe', 'paypal']);
export function isOnline(provider: string): provider is Online { return online.has(provider); }
const invalid = () => new CheckoutError(400, 'Invalid simulated payment event.');

function reference(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,96}$/.test(value)) throw invalid();
  return value;
}

function currency(value: unknown) {
  if (typeof value !== 'string' || !/^[a-zA-Z]{3}$/.test(value)) throw invalid();
  return value.toUpperCase();
}

function minorUnits(value: unknown, code: string) {
  if (typeof value !== 'string' || !/^\d{1,13}(?:\.\d{1,3})?$/.test(value)) throw invalid();
  const [whole, fraction = ''] = value.split('.');
  const scale = currencyScale(code);
  const precision = String(scale).length - 1;
  if (fraction.length > precision) throw invalid();
  return Number(whole) * scale + Number(fraction.padEnd(precision, '0'));
}

function signature(provider: Online, raw: string, timestamp: string) {
  const secret = provider === 'stripe' ? process.env.GRIIPBUDDY_STRIPE_SIM_SECRET : process.env.GRIIPBUDDY_PAYPAL_SIM_SECRET;
  if (!secret || secret.length < 32) throw new CheckoutError(503, 'This payment simulator is unavailable.');
  // Stripe uses the timestamp and exact raw body. PayPal HMAC is a local test issuer, not PayPal's signature protocol.
  return createHmac('sha256', secret).update((provider === 'paypal' ? 'paypal.' : '') + timestamp + '.' + raw).digest('hex');
}

export function acceptCallback(provider: Online, raw: string, header: string) {
  const fields = header.split(',');
  const timestamps = fields.filter((field) => /^t=\d{10}$/.test(field));
  const signatures = fields.filter((field) => /^v1=[a-f0-9]{64}$/.test(field));
  const timestamp = timestamps[0]?.slice(2);
  if (timestamps.length !== 1 || !timestamp || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300
    || !signatures.some((field) => matchesSecret(field.slice(3), signature(provider, raw, timestamp)))) {
    throw new CheckoutError(401, 'Invalid or expired simulator signature.');
  }
  const data = object(parseJson(raw));
  let event: ProviderEvent;
  if (provider === 'stripe') {
    const session = object(object(data.data).object);
    const captured = data.type === 'checkout.session.completed' || data.type === 'checkout.session.async_payment_succeeded';
    const declined = data.type === 'checkout.session.async_payment_failed';
    if (data.livemode !== false || session.object !== 'checkout.session' || (!captured && !declined)
      || captured && session.payment_status !== 'paid' || declined && session.payment_status !== 'unpaid'
      || typeof session.amount_total !== 'number') throw invalid();
    event = {
      id: reference(data.id), orderId: orderId(session.client_reference_id), attempt: reference(session.id),
      transaction: reference(session.payment_intent), outcome: captured ? 'captured' : 'declined',
      total: session.amount_total, currency: currency(session.currency),
    };
  } else {
    const capture = object(data.resource);
    const amount = object(capture.amount);
    const captured = data.event_type === 'PAYMENT.CAPTURE.COMPLETED' && capture.status === 'COMPLETED';
    const declined = data.event_type === 'PAYMENT.CAPTURE.DENIED' && capture.status === 'DECLINED';
    if (!captured && !declined) throw invalid();
    const attempt = reference(object(object(capture.supplementary_data).related_ids).order_id);
    const code = currency(amount.currency_code);
    event = {
      id: reference(data.id), orderId: orderId(attempt.slice('PAYPAL-SIM-'.length)), attempt,
      transaction: reference(capture.id), outcome: captured ? 'captured' : 'declined',
      total: minorUnits(amount.value, code), currency: code,
    };
  }
  if (!Number.isSafeInteger(event.total) || event.total < 1) throw invalid();
  return providerEvent(provider, event);
}

export function simulateHostedPayment(order: CheckoutOrder, outcome: unknown) {
  const provider = order.method;
  if (!isOnline(provider) || (outcome !== 'captured' && outcome !== 'declined')) throw new CheckoutError(400, 'Choose a simulated payment outcome.');
  const paid = outcome === 'captured';
  const id = 'sim_' + outcome + '_' + order.id;
  const raw = JSON.stringify(provider === 'stripe' ? {
    id, livemode: false, type: paid ? 'checkout.session.completed' : 'checkout.session.async_payment_failed',
    data: { object: {
      id: order.providerAttempt, object: 'checkout.session', client_reference_id: order.id, payment_intent: 'pi_sim_' + order.id,
      payment_status: paid ? 'paid' : 'unpaid', amount_total: order.total, currency: order.currency.toLowerCase(),
    } },
  } : {
    id, event_type: paid ? 'PAYMENT.CAPTURE.COMPLETED' : 'PAYMENT.CAPTURE.DENIED', resource: {
      id: 'capture_sim_' + order.id, status: paid ? 'COMPLETED' : 'DECLINED',
      amount: { currency_code: order.currency, value: (order.total / currencyScale(order.currency)).toFixed(String(currencyScale(order.currency)).length - 1) },
      supplementary_data: { related_ids: { order_id: order.providerAttempt } },
    },
  });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  return acceptCallback(provider, raw, 't=' + timestamp + ',v1=' + signature(provider, raw, timestamp));
}
