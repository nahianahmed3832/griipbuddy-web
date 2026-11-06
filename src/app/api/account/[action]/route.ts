import { sameOriginRequest } from '@/app/api/request-origin';
import { accountAction } from '@/features/account/actions-server';
import { AccountError, fields } from '@/features/account/contracts';
import { accountScope, ownOrders, requireCustomer } from '@/features/account/session';

const actions = new Set(['login', 'register', 'verify', 'recover', 'reset', 'logout', 'profile', 'address', 'return',
  'preferences', 'email-send', 'email-verify', 'password', 'cart', 'wishlist']);

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

function failure(error: unknown) {
  return error instanceof AccountError ? json({ error: error.message }, error.status)
    : json({ error: 'Your account is temporarily unavailable. Try again.' }, 503);
}

export async function GET(_request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (action !== 'me' && action !== 'orders') return json({ error: 'Account action not found.' }, 404);
  try {
    const account = await requireCustomer();
    return json(action === 'me' ? accountScope(account) : { orders: await ownOrders(account) });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  if (!actions.has(action)) return json({ error: 'Account action not found.' }, 404);
  if (!sameOriginRequest(request)) return json({ error: 'Use the storefront to manage your account.' }, 403);
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) return json({ error: 'Use JSON for account requests.' }, 415);
  if (Number(request.headers.get('content-length')) > 24_000) return json({ error: 'Account request is too large.' }, 413);
  const input = await request.text();
  if (input.length > 24_000) return json({ error: 'Account request is too large.' }, 413);
  try {
    return json(await accountAction(request, action, fields(JSON.parse(input))));
  } catch (error) {
    return error instanceof SyntaxError ? json({ error: 'Invalid account request.' }, 400) : failure(error);
  }
}
