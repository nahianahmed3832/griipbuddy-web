import 'server-only';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { currentAccount } from '@/features/account/session';
import { CheckoutError } from './contracts';

const guestCookie = 'griipbuddy-checkout';
export const privateHeaders = { 'Cache-Control': 'private, no-store' };

export function reply(body: unknown, status = 200) {
  return Response.json(body, { status, headers: privateHeaders });
}

export function failure(error: unknown) {
  if (error instanceof CheckoutError) return reply({ error: error.message }, error.status);
  return reply({ error: 'Checkout could not complete this request. Try again.' }, 503);
}

export function matchesSecret(given: string, secret: string) {
  const left = Buffer.from(given);
  const right = Buffer.from(secret);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function requireOperator(request: Request) {
  const secret = process.env.GRIIPBUDDY_CHECKOUT_OPERATOR_SECRET;
  if (!secret || secret.length < 32 || !matchesSecret(request.headers.get('authorization') ?? '', 'Bearer ' + secret)) {
    throw new CheckoutError(403, 'Checkout operator authorization is required.');
  }
}

export async function bodyBytes(request: Request, limit: number) {
  if (Number(request.headers.get('content-length')) > limit) throw new CheckoutError(413, 'Request is too large.');
  const reader = request.body?.getReader();
  const parts: Buffer[] = [];
  let size = 0;
  if (reader) {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
          await reader.cancel().catch(() => {});
          throw new CheckoutError(413, 'Request is too large.');
        }
        parts.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
  }
  return Buffer.concat(parts, size);
}

export function parseJson(value: string) {
  try { return JSON.parse(value) as unknown; }
  catch { throw new CheckoutError(400, 'Invalid JSON.'); }
}

export function orderId(value: unknown) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)) {
    throw new CheckoutError(404, 'Order not found.');
  }
  return value;
}

export async function checkoutOwners(issueCookie?: Request) {
  const jar = await cookies();
  let guest = jar.get(guestCookie)?.value;
  if (!guest || !/^[0-9a-f]{64}$/.test(guest)) {
    guest = undefined;
    if (issueCookie) {
      guest = randomBytes(32).toString('hex');
      jar.set(guestCookie, guest, {
        httpOnly: true, sameSite: 'lax', secure: new URL(issueCookie.url).protocol === 'https:', path: '/', maxAge: 60 * 60 * 24 * 30,
      });
    }
  }
  const account = await currentAccount();
  const guestKey = guest && 'guest:' + guest;
  const customerKey = account?.mode === 'fixture' ? 'customer:' + account.profile.id : undefined;
  return { buyer: customerKey ?? guestKey, owners: [customerKey, guestKey].filter((item): item is string => Boolean(item)) };
}
