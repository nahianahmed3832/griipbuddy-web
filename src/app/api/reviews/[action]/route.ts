import { publicBuild } from '@/features/public-build';
import { NextRequest } from 'next/server';
import { currentAccount } from '@/features/account/session';
import { objectId } from '@/features/catalog/api';
import { storefrontExtrasEnabled } from '@/features/catalog/merchandising';
import { publicReviews } from '@/features/catalog/reviews';
import { sameOriginRequest } from '@/app/api/request-origin';

const maxRequest = 5 * 1024 * 1024 + 32768;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
type Context = { params: Promise<{ action: string }> };

function upstream(path: string, init?: RequestInit) {
  const base = process.env.GRIIPBUDDY_CATALOG_API ?? '';
  if (!storefrontExtrasEnabled() || !/^http:\/\/127\.0\.0\.1:\d{4,5}\/api\/v1$/.test(base)) throw new Error('Reviews unavailable');
  return fetch(base + '/storefront-reviews' + path, { ...init, cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(52000) });
}

function error(message: string, status: number) {
  return Response.json({ error: message }, { status, headers });
}

async function json(response: Response) {
  const value = await response.json().catch(() => null);
  if (response.ok && value?.success) return Response.json(value.data, { status: response.status, headers });
  return response.status >= 400 && response.status < 500
    ? error(typeof value?.message === 'string' ? value.message : 'Review request was rejected.', response.status)
    : error('Reviews are temporarily unavailable.', 503);
}

export async function GET(req: NextRequest, context: Context) {
  const { action } = await context.params;
  const params = req.nextUrl.searchParams;
  const id = params.get('id') ?? '';
  if (!objectId(id) || !storefrontExtrasEnabled()) return error('Reviews unavailable.', 404);
  try {
    if (action === 'list') {
      return Response.json(await publicReviews(id, params.get('sort') ?? 'recent', Number(params.get('page')) || 1), { headers });
    }
    if (action === 'eligible' && !publicBuild()) {
      const account = await currentAccount();
      if (account?.mode !== 'recovered') return error('Sign in to write a review.', 401);
      return json(await upstream('/eligible/' + id, { headers: { Authorization: 'Bearer ' + account.token } }));
    }
    const index = params.get('index') ?? '';
    if (action !== 'media' || !/^[0-3]$/.test(index)) return error('Media unavailable.', 404);
    const range = req.headers.get('range');
    const response = await upstream('/media/' + id + '/' + index, { headers: range ? { Range: range } : undefined });
    const mediaHeaders = new Headers(headers);
    for (const key of ['content-type', 'content-length', 'accept-ranges', 'content-range', 'content-security-policy']) {
      const value = response.headers.get(key);
      if (value) mediaHeaders.set(key, value);
    }
    return new Response(response.body, { status: response.status, headers: mediaHeaders });
  } catch {
    return error('Reviews are temporarily unavailable.', 503);
  }
}

export async function POST(req: NextRequest, context: Context) {
  if (publicBuild() || (await context.params).action !== 'submit' || !storefrontExtrasEnabled()) return error('Reviews unavailable.', 404);
  if (!sameOriginRequest(req)) return error('Origin denied.', 403);
  const type = req.headers.get('content-type');
  const length = Number(req.headers.get('content-length'));
  if (!req.body || !type?.startsWith('multipart/form-data;') || !Number.isSafeInteger(length) || length < 1 || length > maxRequest) {
    return error('The review upload exceeds the allowed size.', 413);
  }
  try {
    const account = await currentAccount();
    if (account?.mode !== 'recovered') return error('Sign in to write a review.', 401);
    const reader = req.body.getReader();
    const body = new Uint8Array(length);
    let offset = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (offset + value.length > length) {
        await reader.cancel();
        return error('The review upload exceeds the allowed size.', 413);
      }
      body.set(value, offset);
      offset += value.length;
    }
    if (offset !== length) return error('The review upload was incomplete.', 400);
    return json(await upstream('/', { method: 'POST', body, headers: {
      'Content-Type': type, Authorization: 'Bearer ' + account.token,
    } }));
  } catch {
    return error('Reviews are temporarily unavailable.', 503);
  }
}
