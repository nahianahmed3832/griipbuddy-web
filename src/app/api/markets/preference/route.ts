import { sameOriginRequest } from '@/app/api/request-origin';
import { cookies } from 'next/headers';
import { marketForSegment } from '@/features/catalog/catalog';
import { catalogNavigation } from '@/features/catalog/data';
import { marketCookie } from '@/features/markets/resolve';

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) {
    return new Response(null, { status: 403 });
  }
  const body: unknown = await request.json().catch(() => null);
  const code = body && typeof body === 'object' && 'market' in body ? body.market : null;
  if (typeof code !== 'string' || !/^(?:[a-z]{2}|intl)$/i.test(code)) return new Response(null, { status: 400 });

  try {
    const { markets } = await catalogNavigation();
    const market = marketForSegment(markets, code);
    if (!market) return new Response(null, { status: 404 });
    (await cookies()).set(marketCookie, market.code, {
      path: '/', httpOnly: true, sameSite: 'lax',
      secure: new URL(request.url).protocol === 'https:', maxAge: 60 * 60 * 24 * 365,
    });
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return new Response(null, { status: 503 });
  }
}
