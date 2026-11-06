import { sameOriginRequest } from '@/app/api/request-origin';
import { checkoutEnabled, checkoutPaused } from '@/features/checkout/config';
import { CheckoutError } from '@/features/checkout/contracts';
import { bodyBytes, checkoutOwners, failure, orderId, parseJson, privateHeaders, reply, requireOperator } from '@/features/checkout/http';
import { buyerAction, object, operatorAction, ownedOrder, placeOrder, privateReceipt, publicOrder, receiptLimit } from '@/features/checkout/orders';
import { simulateHostedPayment } from '@/features/checkout/providers';
import { reconcile } from '@/features/checkout/reconcile';

type Params = { params: Promise<{ action: string }> };
const payloadLimit = 30_000;

export async function POST(request: Request, { params }: Params) {
  try {
    if (!checkoutEnabled()) throw new CheckoutError(404, 'Checkout is not available for this catalog.');
    if (!sameOriginRequest(request)) throw new CheckoutError(403, 'Use the storefront to continue.');
    const { action } = await params;
    if (action === 'place' && checkoutPaused()) throw new CheckoutError(503, 'Test checkout is temporarily paused.');
    if (action === 'session') {
      await checkoutOwners(request);
      return reply({ ready: true });
    }
    if (action === 'operator') {
      requireOperator(request);
      const data = object(parseJson((await bodyBytes(request, payloadLimit)).toString()));
      return reply({ order: operatorAction(orderId(data.orderId), data.action, data) });
    }

    const { buyer, owners } = await checkoutOwners();
    if (!buyer) throw new CheckoutError(401, 'Refresh checkout to establish your session.');
    let data: Record<string, unknown>;
    let receipt: File | undefined;
    if (action === 'place' && request.headers.get('content-type')?.startsWith('multipart/form-data;')) {
      const bytes = await bodyBytes(request, payloadLimit + receiptLimit);
      let form: FormData;
      try { form = await new Response(new Uint8Array(bytes), { headers: request.headers }).formData(); }
      catch { throw new CheckoutError(400, 'The receipt request could not be read.'); }
      const payload = form.get('payload');
      const upload = form.get('receipt');
      if (typeof payload !== 'string' || payload.length > payloadLimit || form.getAll('payload').length !== 1
        || form.getAll('receipt').length !== 1 || !upload || typeof upload === 'string') throw new CheckoutError(400, 'Check the receipt request.');
      data = object(parseJson(payload));
      receipt = upload;
    } else data = object(parseJson((await bodyBytes(request, payloadLimit)).toString()));
    if (action === 'place') {
      const result = await placeOrder(buyer, data, receipt);
      return reply({ order: result.order }, result.replay ? 200 : 201);
    }
    const id = orderId(data.orderId);
    if (action === 'cancel' || action === 'return') return reply({ order: buyerAction(id, owners, action, data) });
    if (action === 'simulate') return reply({ order: simulateHostedPayment(ownedOrder(id, owners), data.outcome) });
    throw new CheckoutError(404, 'Checkout action not found.');
  } catch (error) { return failure(error); }
}

export async function GET(request: Request, { params }: Params) {
  try {
    if (!checkoutEnabled()) throw new CheckoutError(404, 'Checkout is not available for this catalog.');
    const { action } = await params;
    if (action === 'reconcile') {
      requireOperator(request);
      return reply(reconcile());
    }
    const query = new URL(request.url).searchParams;
    const id = orderId(query.get('id'));
    if (action === 'receipt') {
      requireOperator(request);
      const receipt = privateReceipt(id);
      if (query.get('format') === 'metadata') return reply({ phone: receipt.phone, reference: receipt.reference });
      return new Response(new Uint8Array(receipt.image), { headers: {
        ...privateHeaders, 'Content-Type': 'image/jpeg', 'Content-Disposition': 'attachment; filename="receipt.jpg"',
        'Content-Security-Policy': "default-src 'none'; sandbox", 'X-Content-Type-Options': 'nosniff',
      } });
    }
    if (action === 'order') return reply({ order: publicOrder(ownedOrder(id, (await checkoutOwners()).owners)) });
    throw new CheckoutError(404, 'Checkout action not found.');
  } catch (error) { return failure(error); }
}
