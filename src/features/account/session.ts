import { publicBuild } from '@/features/public-build';
import 'server-only';

import { cookies } from 'next/headers';
import { cache } from 'react';
import { apiConfigured } from '@/features/catalog/api';
import { checkoutEnabled } from '@/features/checkout/config';
import { statusLabels } from '@/features/checkout/contracts';
import { customerOrders } from '@/features/checkout/orders';
import { currencyScale } from '@/features/cart/cart';
import { AccountError, type AccountScope, type CustomerOrder } from './contracts';
import { seedAccounts } from './fixture';
import { recoveredCustomer, recoveredOrders } from './recovered';
import { accountState, endSession, readSession, startSession } from './state';

export const sessionCookie = 'griipbuddy-customer';
export const challengeCookie = 'griipbuddy-verification';

export const currentAccount = cache(async () => {
  if (publicBuild()) return null;
  const handle = (await cookies()).get(sessionCookie)?.value;
  const session = readSession(handle);
  if (!session || (session.mode === 'recovered') !== apiConfigured()) return null;
  if (session.mode === 'recovered') {
    if (!session.token) return null;
    try {
      const profile = await recoveredCustomer(session.token);
      if (profile.id === session.id) return { mode: session.mode, profile, token: session.token, fixture: undefined } as const;
    } catch (error) {
      if (!(error instanceof AccountError) || error.status !== 401) throw error;
    }
    endSession(handle);
    return null;
  }
  await seedAccounts();
  const fixture = accountState.accounts.get(session.id);
  return fixture ? { mode: 'fixture', profile: fixture.profile, fixture, token: undefined } as const : null;
});

export async function requireCustomer() {
  const account = await currentAccount();
  if (!account) throw new AccountError(401, 'Sign in to access your account.');
  return account;
}

export async function ownOrders(account: NonNullable<Awaited<ReturnType<typeof currentAccount>>>) {
  if (account.mode === 'recovered') return recoveredOrders(account.token, account.profile.id);
  const newOrders: CustomerOrder[] = checkoutEnabled() ? customerOrders('customer:' + account.profile.id).map((order) => ({
    syntheticCheckout: true, id: order.id, number: order.number, status: statusLabels[order.status],
    currency: order.currency, total: order.total / currencyScale(order.currency), date: order.createdAt, tracking: order.tracking,
    lines: order.lines.map((line) => ({ name: line.title, sku: line.sku, quantity: line.quantity })),
    history: order.history.map((entry) => ({ status: statusLabels[entry.status], date: entry.date })),
  })) : [];
  return [...newOrders, ...account.fixture.orders];
}

export function accountScope(account: NonNullable<Awaited<ReturnType<typeof currentAccount>>>): AccountScope {
  return { customer: account.profile, mode: account.mode, cart: account.fixture?.cart };
}

function options(request: Request, maxAge: number) {
  return { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: new URL(request.url).protocol === 'https:', maxAge };
}

export async function setSession(request: Request, session: Parameters<typeof startSession>[0], expires?: number) {
  const jar = await cookies();
  const oldHandle = jar.get(sessionCookie)?.value;
  const issued = startSession(session, expires);
  endSession(oldHandle);
  accountState.challenges.delete(jar.get(challengeCookie)?.value ?? '');
  jar.set(challengeCookie, '', options(request, 0));
  jar.set(sessionCookie, issued.handle, options(request, Math.max(1, Math.floor((issued.expires - Date.now()) / 1000))));
}

export async function clearSession(request: Request) {
  const jar = await cookies();
  endSession(jar.get(sessionCookie)?.value);
  jar.set(sessionCookie, '', options(request, 0));
  accountState.challenges.delete(jar.get(challengeCookie)?.value ?? '');
  jar.set(challengeCookie, '', options(request, 0));
}

export async function setChallenge(request: Request, value: string) {
  const jar = await cookies();
  accountState.challenges.delete(jar.get(challengeCookie)?.value ?? '');
  jar.set(challengeCookie, value, options(request, 5 * 60));
}
