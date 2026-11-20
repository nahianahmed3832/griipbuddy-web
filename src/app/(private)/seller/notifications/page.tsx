import { notFound } from "next/navigation";
import { NotificationInbox } from "@/components/notification-inbox";
import { NotificationError, notificationInbox } from "@/lib/notifications/inbox";
import { currentMarket } from "@/lib/market-server";
import { getShopper } from "@/lib/marketplace/auth";

export const metadata = { title: "Shop notifications", robots: { index: false, follow: false } };

export default async function ShopNotifications({ searchParams }: {
  searchParams: Promise<{ market?: string | string[]; shop?: string | string[] }>;
}) {
  const [shopper, market, query] = await Promise.all([getShopper(), currentMarket(), searchParams]);
  if (!shopper || query.market !== undefined && query.market !== market.id || Array.isArray(query.shop)) notFound();
  const items = await notificationInbox({ audience: "seller", actorId: shopper.id, marketId: market.id, shopId: query.shop })
    .catch(error => { if (error instanceof NotificationError) notFound(); throw error; });
  return <div className="seller-content">
    <h1>Shop notifications</h1>
    <p>Order notifications for your shop in {market.name}.</p>
    <NotificationInbox items={items} marketId={market.id} audience="seller" shopId={query.shop}/>
  </div>;
}
