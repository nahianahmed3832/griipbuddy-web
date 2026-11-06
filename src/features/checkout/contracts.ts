import type { CartQuote } from '@/features/cart/cart';

export const methodIds = ['cod', 'manual', 'paypal', 'stripe'] as const;
export type Method = (typeof methodIds)[number];
export type Online = Extract<Method, 'stripe' | 'paypal'>;
export type MethodOption = { id: Method; label: string; description: string; advancePercent?: number };
export const methodDetails: Record<Method, { label: string; description: string }> = {
  cod: { label: 'Cash on delivery', description: 'Pay the full amount when your order arrives.' },
  manual: { label: 'Advance payment', description: 'Submit a transaction reference and receipt for review.' },
  paypal: { label: 'PayPal', description: 'Continue to the PayPal simulator after placing your order.' },
  stripe: { label: 'Card via Stripe', description: 'Continue to the Stripe simulator after placing your order.' },
};

export type Delivery = { name: string; phone: string; street: string; city: string; region: string; postal: string };
export type OrderLine = { productId: string; variantId: string; slug: string; title: string; sku: string; quantity: number; unit: number };
export type Status = 'awaiting-payment' | 'awaiting-review' | 'placed' | 'dispatched' | 'delivered' | 'cancelled' | 'expired' | 'returned';
export type PaymentStatus = 'due-on-delivery' | 'pending' | 'review' | 'advance-verified' | 'paid' | 'failed' | 'void' | 'refund-pending' | 'refunded';
export type CheckoutOrder = {
  id: string; number: string; createdAt: string; market: string; currency: string; total: number; shipping: number;
  discount: number; method: Method; delivery: Delivery; lines: OrderLine[]; status: Status; payment: PaymentStatus;
  paid: number; advanceDue: number; refunded: number; expiresAt: number | null; history: { status: Status; date: string }[];
  tracking?: string; collectedOnDelivery?: number; manualReference?: string; manualPhone?: string; transaction?: string; providerAttempt?: string;
  returnRequest?: { kind: 'return' | 'refund'; reason: string; state: 'requested' | 'accepted'; date: string };
};

export const statusLabels: Record<Status, string> = {
  'awaiting-payment': 'Awaiting payment', 'awaiting-review': 'Awaiting receipt review', placed: 'Order placed',
  dispatched: 'Dispatched', delivered: 'Delivered', cancelled: 'Cancelled', expired: 'Reservation expired', returned: 'Returned',
};
export const paymentLabels: Record<PaymentStatus, string> = {
  'due-on-delivery': 'Due on delivery', pending: 'Pending', review: 'Under review', 'advance-verified': 'Advance verified',
  paid: 'Paid', failed: 'Failed', void: 'Voided', 'refund-pending': 'Refund pending', refunded: 'Refunded',
};

// Echo the exact reviewed values. The server reconstructs these independently; the echo never supplies selling prices.
export function quoteReview(quote: CartQuote) {
  return {
    currency: quote.currency, total: quote.estimatedTotal, shipping: quote.shipping.status === 'estimated' ? quote.shipping.amount : null,
    coupon: quote.couponDiscount, ...(quote.checkoutRevision && { revision:quote.checkoutRevision }), lines: quote.lines.map((line) => [line.productId, line.variantId, line.quantity, line.unit]),
  };
}

export class CheckoutError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
