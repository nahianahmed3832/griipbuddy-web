import { sameOriginRequest } from '@/app/api/request-origin';
import { marketForSegment } from '@/features/catalog/catalog';
import { catalogNavigation } from '@/features/catalog/data';
import { lineKey, maxCartLines, parseCoupon, parseLine } from '@/features/cart/cart';
import { quoteCart } from '@/features/cart/quote';

function json(data: unknown, status = 200) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
}

export async function POST(request: Request) {
  if (!sameOriginRequest(request)) {
    return json({ error: 'Use the storefront to request a bag estimate.' }, 403);
  }
  if (Number(request.headers.get('content-length')) > 20_000) return json({ error: 'Bag request is too large.' }, 413);
  const input = await request.text();
  if (input.length > 20_000) return json({ error: 'Bag request is too large.' }, 413);

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(input);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid request');
    body = parsed as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid bag request.' }, 400);
  }
  if (typeof body.market !== 'string' || !/^(?:[a-z]{2}|intl)$/i.test(body.market)
    || !Array.isArray(body.lines) || body.lines.length > maxCartLines) {
    return json({ error: 'Select a market and check the bag items.' }, 400);
  }
  const lines = body.lines.flatMap((value) => parseLine(value) ?? []);
  if (lines.length !== body.lines.length || new Set(lines.map(lineKey)).size !== lines.length) {
    return json({ error: 'Use one valid quantity per product variant.' }, 400);
  }
  const coupon = parseCoupon(body.coupon);
  if (body.coupon !== undefined && !coupon) return json({ error: 'Enter a valid coupon code.' }, 400);
  const preview = body.preview;
  if (preview !== undefined && preview !== 'approve' && preview !== 'decline') return json({ error: 'Invalid preview request.' }, 400);

  try {
    const { markets } = await catalogNavigation();
    const market = marketForSegment(markets, body.market);
    if (!market) return json({ error: 'This market is unavailable.' }, 404);
    return json(await quoteCart(market, lines, coupon, preview));
  } catch {
    return json({ error: 'Prices and stock could not be verified. Try again.' }, 503);
  }
}
