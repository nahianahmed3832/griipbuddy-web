import { uuid } from "@/lib/commerce/checkout-types";
import { bangladeshDocumentOrderSelect, nativeBangladeshOrderDocument } from "@/lib/commerce/bd-order-document";
import { bangladeshDocumentShopper, downloadOrderDocument, unavailableOrderDocument } from "@/lib/commerce/bd-order-document-download";
import { getDb } from "@/lib/db/client";
import { reportFailure } from "@/lib/db/observability";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const id = uuid.safeParse((await params).id);
  if (!id.success) return unavailableOrderDocument();
  try {
    const shopper = await bangladeshDocumentShopper();
    if (!shopper) return unavailableOrderDocument();
    const db = getDb();
    // Payment, order and confirmed-refund snapshots follow the same transaction boundary.
    const order = await db.$transaction(tx => tx.order.findFirst({ where: { id: id.data, marketId: "bd", currency: "BDT", shopperId: shopper.id },
      select: bangladeshDocumentOrderSelect }), { isolationLevel: "RepeatableRead" });
    return order ? await downloadOrderDocument(nativeBangladeshOrderDocument(order)) : unavailableOrderDocument();
  } catch (error) {
    reportFailure("bd-order-hub.download", undefined, error);
    return unavailableOrderDocument(503);
  }
}
