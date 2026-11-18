import { earlierBangladeshOrderDocument } from "@/lib/commerce/bd-order-document";
import { bangladeshDocumentShopper, downloadOrderDocument, unavailableOrderDocument } from "@/lib/commerce/bd-order-document-download";
import { reportFailure } from "@/lib/db/observability";
import { currentAccountLanguage } from "@/lib/marketplace/account-language-server";
import { bdLegacyAccess } from "@/lib/marketplace/bd-order-hub";
import { legacyId, legacyKind, legacyOrderDetail, OrderHubBridgeError } from "@/lib/marketplace/bd-order-hub-bridge";

export async function GET(_request: Request, { params }: { params: Promise<{ kind: string; id: string }> }) {
  const path = await params;
  const kind = legacyKind.safeParse(path.kind);
  const id = legacyId.safeParse(path.id);
  if (!kind.success || !id.success) return unavailableOrderDocument();
  try {
    const shopper = await bangladeshDocumentShopper();
    if (!shopper) return unavailableOrderDocument();
    const access = await bdLegacyAccess(shopper.id);
    if (!access.legacyCustomerId && !access.grants.some(grant => grant.kind === kind.data && grant.id === id.data)) {
      return unavailableOrderDocument();
    }
    const [order, language] = await Promise.all([legacyOrderDetail(access, kind.data, id.data), currentAccountLanguage("bd")]);
    return await downloadOrderDocument(earlierBangladeshOrderDocument(order, language));
  } catch (error) {
    if (error instanceof OrderHubBridgeError && error.status === 404) return unavailableOrderDocument();
    reportFailure("bd-order-hub.history-download", undefined, error);
    return unavailableOrderDocument(503);
  }
}
