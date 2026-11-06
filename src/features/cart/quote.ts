import 'server-only';
import { apiConfigured } from '@/features/catalog/api';
import { currentPrice, type Market } from '@/features/catalog/catalog';
import { catalogProduct, mapLimited, variantStock } from '@/features/catalog/data';
import { currencyScale, type CartLine, type CartQuote, type QuotedLine } from './cart';
import { shippingEstimate } from './shipping';
import { integratedCheckout, integratedPolicy } from '@/features/checkout/integrated';

async function quoteLine(market: Market, line: CartLine): Promise<QuotedLine> {
  const { productId, variantId, slug, quantity } = line;
  const identity = { productId, variantId, slug, quantity };
  const product = await catalogProduct(market, slug);
  const variant = product?.id === productId ? product.variants.find((entry) => entry.id === variantId) : undefined;
  if (!product || !variant) return { ...identity, status: 'unavailable' };
  const display = {
    ...identity, title: product.name, sku: variant.sku,
    options: Object.entries(variant.attributes).map(([key, value]) => key + ': ' + value),
    image: variant.images[0] ?? product.images[0],
  };
  if (!variant.price) return { ...display, status: 'unpriced' };

  const scale = currencyScale(market.currency);
  const unit = Math.round((currentPrice(variant.price) + Number.EPSILON) * scale);
  const regular = Math.round((variant.price.regular + Number.EPSILON) * scale);
  if (!Number.isSafeInteger(unit) || !Number.isSafeInteger(regular) || unit <= 0 || regular > 1_000_000_000 || unit > regular) {
    return { ...display, status: 'unpriced' };
  }
  const available = await variantStock(product, variant);
  const priced = { ...display, unit, regular };
  if (available === null) return { ...priced, status: 'unknown' };
  if (available === 0) return { ...priced, status: 'out', available };
  if (quantity > available) return { ...priced, status: 'insufficient', available };
  return { ...priced, status: 'ready', available, lineTotal: unit * quantity };
}

function quoteCoupon(code: string | undefined, market: Market, ready: boolean, net: number) {
  if (!code) return { discount: 0 };
  if (apiConfigured()) return { discount: 0, coupon: { code, status: 'unavailable' as const } };
  if (!ready) return { discount: 0, coupon: { code, status: 'needs-items' as const } };
  if (code !== 'PREVIEW10' || !['US', 'BD'].includes(market.code)) {
    return { discount: 0, coupon: { code, status: 'invalid' as const } };
  }
  return { discount: Math.round(net / 10), coupon: { code, status: 'applied' as const } };
}

export async function quoteCart(market: Market, lines: CartLine[], code?: string, preview?: 'approve' | 'decline'): Promise<CartQuote> {
  const quoted = await mapLimited(lines, 4, (line) => quoteLine(market, line));
  const ready = quoted.filter((line) => line.status === 'ready');
  const subtotal = ready.reduce((sum, line) => sum + (line.regular ?? 0) * line.quantity, 0);
  const net = ready.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0);
  const allReady = ready.length > 0 && ready.length === lines.length;
  const { discount, coupon } = quoteCoupon(code, market, allReady, net);
  const policy = integratedCheckout() ? await integratedPolicy(market.code) : null;
  const shipping: CartQuote['shipping'] = policy?.methods.length && policy.currency === market.currency && policy.shippingMinor !== undefined
    ? { status:'estimated', amount:policy.shippingMinor }
    : shippingEstimate(market);
  const merchandise = net - discount;
  const reviewReady = allReady && shipping.status === 'estimated';
  return {
    market: market.code, currency: market.currency, lines: quoted,
    subtotal, saleDiscount: subtotal - net, couponDiscount: discount, coupon, merchandise, shipping,
    estimatedTotal: reviewReady ? merchandise + shipping.amount : null,
    reviewReady, checkoutRevision:policy?.revision,
    paymentPreview: reviewReady && preview ? (preview === 'approve' ? 'approved' : 'declined') : undefined,
  };
}
