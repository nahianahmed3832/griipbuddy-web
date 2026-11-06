import 'server-only';
import { type CheckoutOrder } from './contracts';
import { releaseExpired, transaction } from './ledger';

export function reconcile() {
  releaseExpired();
  return transaction((db) => {
    const orders = (db.prepare('SELECT document FROM orders').all() as { document: string }[])
      .map((row) => JSON.parse(row.document) as CheckoutOrder);
    const errors: string[] = [];
    const expected = new Map<string, { held: number; deducted: number }>();
    const counts: Record<string, number> = {};
    const totals: Record<string, { ordered: number; paid: number; refunded: number }> = {};
    for (const order of orders) {
      counts[order.status] = (counts[order.status] ?? 0) + 1;
      const total = totals[order.currency] ??= { ordered: 0, paid: 0, refunded: 0 };
      total.ordered += order.total;
      total.paid += order.paid;
      total.refunded += order.refunded;
      if (order.refunded > order.paid || order.paid > order.total || order.paid < 0
        || ((order.payment === 'refunded') !== (order.refunded > 0))) errors.push('Order payment arithmetic: ' + order.id);
      for (const line of order.lines) {
        const key = line.productId + ':' + line.variantId;
        const stock = expected.get(key) ?? { held: 0, deducted: 0 };
        if (['placed', 'awaiting-payment', 'awaiting-review'].includes(order.status)) stock.held += line.quantity;
        if (['dispatched', 'delivered'].includes(order.status)) stock.deducted += line.quantity;
        expected.set(key, stock);
      }
    }
    const stock = db.prepare('SELECT product,variant,initial,on_hand,held FROM stock').all() as
      { product: string; variant: string; initial: number; on_hand: number; held: number }[];
    for (const row of stock) {
      const key = row.product + ':' + row.variant;
      const amount = expected.get(key) ?? { held: 0, deducted: 0 };
      if (row.held !== amount.held || row.on_hand !== row.initial - amount.deducted) errors.push('Stock mismatch: ' + key);
      expected.delete(key);
    }
    if (expected.size) errors.push('Orders reference missing stock rows.');
    if ((db.pragma('foreign_key_check') as unknown[]).length) errors.push('Foreign key check failed.');
    return { ok: !errors.length, errors, orders: orders.length, stockRows: stock.length, counts, totals };
  });
}
