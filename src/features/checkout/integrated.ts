import 'server-only';
import { CheckoutError, methodDetails, methodIds, type CheckoutOrder, type MethodOption } from './contracts';
import { currentAccount } from '@/features/account/session';

export function integratedCheckout() {
  return process.env.GRIIPBUDDY_CHECKOUT === 'integrated'
    && /^http:\/\/127\.0\.0\.1:\d{4,5}\/api\/v1$/.test(process.env.GRIIPBUDDY_CATALOG_API ?? '');
}

export async function commerceRequest<T>(path: string, { token, data }: { token?: string; data?: unknown } = {}) {
  if (!integratedCheckout()) throw new CheckoutError(404, 'Integrated checkout is unavailable.');
  const base = process.env.GRIIPBUDDY_CATALOG_API!;
  const response = await fetch(base + '/commerce' + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: { ...(data !== undefined && { 'Content-Type': 'application/json' }), ...(token && { Authorization: 'Bearer ' + token }) },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(15000), cache: 'no-store', redirect: 'error',
  }).catch(() => { throw new CheckoutError(503, 'Checkout is temporarily unavailable.'); });
  const result = await response.json().catch(() => null);
  if (!response.ok || result?.success !== true) {
    const status = response.status;
    throw new CheckoutError(status >= 400 && status < 500 ? status : 503,
      status >= 400 && status < 500 && typeof result?.message === 'string' ? result.message : 'Checkout is temporarily unavailable.');
  }
  return { data: result.data as T, status: response.status };
}

export async function integratedToken() {
  const account = await currentAccount();
  if (account?.mode !== 'recovered') throw new CheckoutError(401, 'Sign in to your GriipBuddy account to place or view an order.');
  return account.token;
}

export const integratedOrderId = (value: unknown) => {
  if (typeof value !== 'string' || !/^[a-f0-9]{24}$/.test(value)) throw new CheckoutError(404, 'Order not found.');
  return value;
};

export async function integratedOrder(id: unknown) {
  return (await commerceRequest<CheckoutOrder>('/orders/' + integratedOrderId(id), { token: await integratedToken() })).data;
}

type Policy = { currency: string; methods: string[]; shippingMinor?: number; advancePercent?: number; revision?: string };

export async function integratedPolicy(market: string): Promise<Policy | null> {
  if (!/^[A-Z]{2}$/.test(market)) return null;
  try {
    return (await commerceRequest<Policy>('/market/' + market)).data;
  } catch (error) {
    if (error instanceof CheckoutError && error.status === 404) return null;
    throw error;
  }
}

export async function integratedMethods(market: string): Promise<MethodOption[]> {
  const policy = await integratedPolicy(market);
  if (!policy || process.env.GRIIPBUDDY_CHECKOUT_PAUSED === '1') return [];
  return methodIds.filter(id => policy.methods.includes(id))
    .map(id => ({ id, ...methodDetails[id], ...(id === 'manual' && { advancePercent: policy.advancePercent }) }));
}
