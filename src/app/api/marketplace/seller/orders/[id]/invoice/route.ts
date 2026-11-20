import { invoiceAttachment } from "@/lib/commerce/invoice-download";
import { orderDate, orderLabels } from "@/lib/commerce/labels";
import { privateHeaders } from "@/lib/db/http";
import { isMarketSelectable, marketConfiguration, marketForStorefrontOrigin } from "@/lib/market-config";
import { currentMarket } from "@/lib/market-server";
import { shopperActor } from "@/lib/marketplace/auth";
import { sellerOrderDetail, sellerOrderWorkspace } from "@/lib/marketplace/seller-orders";
import { marketplaceMode } from "@/lib/release-config";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const missing = () => new Response(null, { status: 404, headers: privateHeaders });
  if (!marketplaceMode()) return missing();
  const shopper = await shopperActor(request.headers);
  if (!shopper) return missing();
  const requestUrl = new URL(request.url);
  const requested = requestUrl.searchParams.getAll("market");
  const routed = marketForStorefrontOrigin(requestUrl.origin);
  if (requested.length > 1 || requested.length === 1 && (!isMarketSelectable(requested[0]) || routed && routed !== requested[0])) return missing();
  const marketId = isMarketSelectable(requested[0]) ? requested[0] : routed ?? (await currentMarket()).id;
  const shops = requestUrl.searchParams.getAll("shop");
  if (shops.length > 1) return missing();
  const shop = await sellerOrderWorkspace(shopper.id, marketId, shops[0]);
  if (!shop?.finance) return missing();
  const order = await sellerOrderDetail(shop.id, (await params).id, marketId);
  if (!order) return missing();
  const market = marketConfiguration(marketId);
  const subtotal = order.items.reduce((sum, item) => sum + item.lineTotalMinor, 0);
  const allocated = order.items.every(item => item.deliveryAllocatedMinor !== null && item.taxAllocatedMinor !== null);
  return invoiceAttachment({
    audience: "seller", reference: order.reference, market, date: orderDate(order.createdAt, market.id), items: order.items,
    status: orderLabels[order.status], recipient: { title: "Seller", lines: [shop.name] },
    totals: [
      { label: "Shop merchandise subtotal", amountMinor: subtotal },
      ...(allocated ? [
        { label: "Allocated delivery", amountMinor: order.items.reduce((sum, item) => sum + (item.deliveryAllocatedMinor ?? 0), 0) },
        { label: "Allocated tax", amountMinor: order.items.reduce((sum, item) => sum + (item.taxAllocatedMinor ?? 0), 0) },
      ] : []),
    ],
    notes: ["This invoice covers the shop’s own purchased lines.", ...(!allocated ? ["Delivery and tax allocations are unavailable for this order."] : [])],
  });
}
