import { adminEnabled, appendAdminEvent, checkoutPreferences, sandboxProvider, savePreferences } from '@/features/checkout/admin-preferences';
import { CheckoutError, type CheckoutOrder } from '@/features/checkout/contracts';
import { bodyBytes, failure, orderId, parseJson, privateHeaders, reply, requireOperator } from '@/features/checkout/http';
import { checkoutDb, orderRecord, releaseExpired, transaction } from '@/features/checkout/ledger';
import { object, operatorAction, privateReceipt } from '@/features/checkout/orders';

export const dynamic = 'force-dynamic';

function authorize(request: Request) {
  if (!adminEnabled()) throw new CheckoutError(404, 'Checkout management is unavailable.');
  requireOperator(request);
}

export function GET(request: Request) {
  try {
    authorize(request);
    const query = new URL(request.url).searchParams;
    const id = query.get('receipt');
    if (id) {
      const receipt = privateReceipt(orderId(id));
      if (query.get('format') === 'metadata') return reply({phone:receipt.phone,reference:receipt.reference});
      return new Response(new Uint8Array(receipt.image), { headers:{
        ...privateHeaders, 'Content-Type':'image/jpeg', 'Content-Disposition':'attachment; filename="receipt.jpg"',
        'Content-Security-Policy':"default-src 'none'; sandbox", 'X-Content-Type-Options':'nosniff',
      } });
    }
    releaseExpired();
    const db = checkoutDb();
    const orders = db.prepare(`
      SELECT document FROM orders
      WHERE json_extract(document, '$.status')='awaiting-review'
      ORDER BY rowid DESC LIMIT 50
    `).all() as {document:string}[];
    const queue = orders.map(row => {
      const { id, number, createdAt, market, currency, advanceDue, status } = JSON.parse(row.document) as CheckoutOrder;
      return { id, number, createdAt, market, currency, advanceDue, status };
    });
    const history = db.prepare('SELECT actor,action,target,created_at FROM checkout_admin_history ORDER BY id DESC LIMIT 25').all();
    return reply({ preferences:checkoutPreferences(), providers:{ paypal:sandboxProvider.paypal(), stripe:sandboxProvider.stripe() }, queue, history });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    authorize(request);
    const input = object(parseJson((await bodyBytes(request, 6000)).toString('utf8')));
    const actor = input.actor;
    if (typeof actor !== 'string' || !/^[a-f0-9]{24}$/i.test(actor)) throw new CheckoutError(400,'Missing staff identity.');
    if (input.action === 'settings') return reply({ preferences:savePreferences(input,actor) });
    if (input.action === 'approve-receipt' || input.action === 'reject-receipt') {
      const id = orderId(input.orderId);
      releaseExpired();
      const order = transaction(db => {
        const before = orderRecord(db,id).order;
        if (before.method !== 'manual') throw new CheckoutError(409,'Only manual orders have a receipt review.');
        const updated = operatorAction(id,input.action,input);
        if (updated.payment !== before.payment) appendAdminEvent(db,actor,input.action as string,id);
        return updated;
      });
      return reply({ order });
    }
    throw new CheckoutError(400,'Unknown checkout administration action.');
  } catch (error) { return failure(error); }
}
