import { uuid } from "@/lib/commerce/checkout-types";
import { documentOrderSelect, nativeOrderDocument } from "@/lib/commerce/order-document";
import { orderDocumentAccount, downloadOrderDocument, unavailableOrderDocument } from "@/lib/commerce/order-document-download";
import { getDb } from "@/lib/db/client";
import { reportFailure } from "@/lib/db/observability";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = uuid.safeParse((await params).id);
  if (!id.success) return unavailableOrderDocument();
  try {
    const account = await orderDocumentAccount();
    if (!account) return unavailableOrderDocument();
    const { market, shopper } = account;
    const db = getDb();
    // Payment, order and confirmed-refund snapshots follow the same transaction boundary.
    const order = await db.$transaction(tx => tx.order.findFirst({
      where: { id: id.data, marketId: market.id, currency: market.currency, shopperId: shopper.id },
      select: documentOrderSelect,
    }), { isolationLevel: "RepeatableRead" });
    return order ? await downloadOrderDocument(nativeOrderDocument(order)) : unavailableOrderDocument();
  } catch (error) {
    reportFailure("order-center.download", undefined, error);
    return unavailableOrderDocument(503);
  }
}
