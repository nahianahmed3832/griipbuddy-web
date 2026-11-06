import { formatMoney, validSlug, type Market } from '@/features/catalog/catalog';

export const maxCartLines = 20;
export const maxLineQuantity = 100;

export type CartIdentity = { productId: string; variantId: string; slug: string };
export type CartLine = CartIdentity & { quantity: number; label?: string };
export type CartSnapshot = { version: 1; transferId?: string; lines: CartLine[]; coupon?: { market: string; code: string } };
export type LineStatus = 'ready' | 'unavailable' | 'unpriced' | 'out' | 'insufficient' | 'unknown';

export type QuotedLine = CartIdentity & {
  quantity: number;
  status: LineStatus;
  title?: string;
  sku?: string;
  options?: string[];
  image?: string;
  available?: number;
  unit?: number;
  regular?: number;
  lineTotal?: number;
};

export type CartQuote = {
  market: string;
  currency: string;
  lines: QuotedLine[];
  subtotal: number;
  saleDiscount: number;
  couponDiscount: number;
  coupon?: { code: string; status: 'applied' | 'invalid' | 'unavailable' | 'needs-items' };
  merchandise: number;
  shipping: { status: 'estimated'; amount: number } | { status: 'destination-required' | 'unconfigured' };
  estimatedTotal: number | null;
  reviewReady: boolean;
  checkoutRevision?: string;
  paymentPreview?: 'approved' | 'declined';
};

const identifier = /^[a-z0-9][a-z0-9_-]{0,127}$/i;

export function lineKey(line: CartIdentity) {
  return line.productId + ':' + line.variantId;
}

export function parseLine(value: unknown): CartLine | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { productId, variantId, slug, quantity, label } = value as Record<string, unknown>;
  if (typeof productId !== 'string' || !identifier.test(productId) || typeof variantId !== 'string' || !identifier.test(variantId)
    || typeof slug !== 'string' || !validSlug(slug) || typeof quantity !== 'number'
    || !Number.isInteger(quantity) || quantity < 1 || quantity > maxLineQuantity) return undefined;
  return { productId, variantId, slug, quantity, ...(typeof label === 'string' && { label: label.trim().slice(0, 120) }) };
}

export function parseCoupon(value: unknown) {
  return typeof value === 'string' && /^[a-z0-9_-]{1,32}$/i.test(value.trim()) ? value.trim().toUpperCase() : undefined;
}

export function mergeCartLines(existing: CartLine[], additions: CartLine[]) {
  const merged = new Map(existing.map((line) => [lineKey(line), line]));
  for (const line of additions) {
    const key = lineKey(line);
    const previous = merged.get(key);
    const quantity = line.quantity + (previous?.quantity ?? 0);
    if (quantity > maxLineQuantity) return undefined;
    merged.set(key, { ...line, quantity });
  }
  return merged.size <= maxCartLines ? [...merged.values()] : undefined;
}

export function currencyScale(currency: string) {
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  return 10 ** digits;
}

export function formatMinor(amount: number, market: Market) {
  return formatMoney(amount / currencyScale(market.currency), market);
}
