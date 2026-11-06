import { checkoutEnabled } from '@/features/checkout/config';
import { CheckoutError } from '@/features/checkout/contracts';
import { bodyBytes, failure, reply } from '@/features/checkout/http';
import { acceptCallback, isOnline } from '@/features/checkout/providers';

export async function POST(request: Request, { params }: { params: Promise<{ provider: string }> }) {
  try {
    const { provider } = await params;
    if (!checkoutEnabled() || !isOnline(provider)) throw new CheckoutError(404, 'Payment simulator not found.');
    const bytes = await bodyBytes(request, 20_000);
    let raw: string;
    try { raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new CheckoutError(400, 'Invalid callback encoding.'); }
    const header = provider === 'stripe' ? 'stripe-signature' : 'x-griipbuddy-sim-signature';
    acceptCallback(provider, raw, request.headers.get(header) ?? '');
    return reply({ received: true });
  } catch (error) { return failure(error); }
}
