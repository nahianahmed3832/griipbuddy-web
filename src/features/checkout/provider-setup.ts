import 'server-only';
import { currencyScale } from '@/features/cart/cart';

export type ProviderQuote = {
  reference: string;
  requestKey: string;
  total: number;
  currency: string;
  returnPath: string;
  cancelPath: string;
};
export type ProviderSession = { id: string; redirect: string };

function validate(quote: ProviderQuote) {
  if (!/^[a-f0-9-]{36}$/i.test(quote.requestKey) || !/^[a-zA-Z0-9_-]{1,100}$/.test(quote.reference)
    || !/^[A-Z]{3}$/.test(quote.currency) || !Number.isSafeInteger(quote.total) || quote.total <= 0) {
    throw new Error('Invalid provider quote.');
  }
  const configured = process.env.GRIIPBUDDY_PROVIDER_RETURN_ORIGIN;
  if (!configured) throw new Error('Provider return origin is missing.');
  const origin = new URL(configured);
  if (origin.protocol !== 'https:' || origin.href !== origin.origin + '/' || origin.username || origin.password) {
    throw new Error('Provider return origin must use HTTPS.');
  }
  const destination = (path: string) => {
    if (!/^\/[a-z0-9/_-]+$/i.test(path) || path.startsWith('//')) throw new Error('Invalid provider return path.');
    return origin.origin + path;
  };
  return { success: destination(quote.returnPath), cancel: destination(quote.cancelPath) };
}

async function send(url: string, init: RequestInit, transport: typeof fetch) {
  const response = await transport(url, { ...init, redirect:'error', cache:'no-store', signal:AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error('The sandbox provider rejected the request.');
  return response.json();
}

function redirect(value: unknown, host: string) {
  if (typeof value !== 'string') throw new Error('Provider did not return a checkout URL.');
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.hostname !== host || parsed.port || parsed.username || parsed.password) {
    throw new Error('Invalid provider checkout URL.');
  }
  return parsed.href;
}

/** Server-side sandbox setup. The simulated checkout never calls these adapters. */
export async function stripeSandboxSession(quote: ProviderQuote, transport = fetch): Promise<ProviderSession> {
  const destinations = validate(quote);
  const key = process.env.GRIIPBUDDY_STRIPE_TEST_SECRET;
  if (!key?.startsWith('sk_test_')) throw new Error('Stripe sandbox is unconfigured.');
  const body = new URLSearchParams({
    mode:'payment', success_url: destinations.success, cancel_url: destinations.cancel,
    client_reference_id: quote.reference, 'line_items[0][quantity]':'1',
    'line_items[0][price_data][currency]':quote.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]':String(quote.total),
    'line_items[0][price_data][product_data][name]':'GriipBuddy test order',
  });
  const result = await send('https://api.stripe.com/v1/checkout/sessions', { method:'POST', body,
    headers:{ Authorization:'Bearer ' + key, 'Idempotency-Key':quote.requestKey } }, transport);
  if (result.livemode !== false || typeof result.id !== 'string' || !result.id.startsWith('cs_test_')) {
    throw new Error('Unexpected Stripe sandbox response.');
  }
  return { id:result.id, redirect:redirect(result.url, 'checkout.stripe.com') };
}

export async function paypalSandboxOrder(quote: ProviderQuote, transport = fetch): Promise<ProviderSession> {
  const destinations = validate(quote);
  const client = process.env.GRIIPBUDDY_PAYPAL_SANDBOX_CLIENT_ID;
  const secret = process.env.GRIIPBUDDY_PAYPAL_SANDBOX_CLIENT_SECRET;
  if (!client || !secret) throw new Error('PayPal sandbox is unconfigured.');
  const token = await send('https://api-m.sandbox.paypal.com/v1/oauth2/token', { method:'POST',
    headers:{ Authorization:'Basic ' + Buffer.from(client + ':' + secret).toString('base64') },
    body:new URLSearchParams({ grant_type:'client_credentials' }) }, transport);
  if (typeof token.access_token !== 'string') throw new Error('PayPal sandbox authorization failed.');
  const scale = currencyScale(quote.currency);
  const order = await send('https://api-m.sandbox.paypal.com/v2/checkout/orders', { method:'POST',
    headers:{ Authorization:'Bearer ' + token.access_token, 'Content-Type':'application/json', 'PayPal-Request-Id':quote.requestKey },
    body:JSON.stringify({ intent:'CAPTURE', purchase_units:[{ reference_id:quote.reference,
      amount:{ currency_code:quote.currency, value:(quote.total / scale).toFixed(String(scale).length - 1) } }],
      payment_source:{ paypal:{ experience_context:{ return_url:destinations.success, cancel_url:destinations.cancel } } } }) }, transport);
  const link = Array.isArray(order.links) && order.links.find((item: { rel?: string }) => ['approve','payer-action'].includes(item.rel ?? ''));
  if (typeof order.id !== 'string' || !link) throw new Error('Unexpected PayPal sandbox response.');
  return { id:order.id, redirect:redirect(link.href, 'www.sandbox.paypal.com') };
}
