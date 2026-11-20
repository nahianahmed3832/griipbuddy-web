import { cookies } from "next/headers";
import { guestCookie, readGuestKey } from "@/lib/commerce/guest";
import { invoiceAttachment } from "@/lib/commerce/invoice-download";
import { orderDate, orderLabels, paymentLabels, paymentMethodLabels } from "@/lib/commerce/labels";
import { guestOrder } from "@/lib/commerce/orders";
import { privateHeaders } from "@/lib/db/http";
import { marketConfiguration } from "@/lib/market-config";
import { getShopper } from "@/lib/marketplace/auth";
import { marketplaceMode } from "@/lib/release-config";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const [{ id }, jar, shopper] = await Promise.all([params, cookies(), marketplaceMode() ? getShopper() : null]);
  const key = readGuestKey(jar.get(guestCookie)?.value);
  const order = key || shopper ? await guestOrder(id, key, shopper?.id) : null;
  if (!order?.payment) return new Response(null, { status: 404, headers: privateHeaders });
  const market = { ...marketConfiguration(order.marketId), currency: order.currency };
  return invoiceAttachment({
    audience: "customer", reference: order.reference, market, date: orderDate(order.createdAt, market.id), items: order.items,
    status: [orderLabels[order.status], paymentMethodLabels[order.payment.method], paymentLabels[order.payment.status]].join(" · "),
    recipient: { title: "Delivery address", lines: [
      order.customerName, order.address, [order.locality, order.districtLabel, order.postalCode].filter(Boolean).join(", "),
    ] },
    totals: [
      { label: "Merchandise subtotal", amountMinor: order.subtotalMinor },
      ...(order.discountMinor ? [{ label: "Discount", amountMinor: -order.discountMinor }] : []),
      { label: "Delivery", amountMinor: order.deliveryMinor },
      { label: order.taxLabel, amountMinor: order.taxMinor },
      { label: "Order total", amountMinor: order.totalMinor },
    ],
  });
}
