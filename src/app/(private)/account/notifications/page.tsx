import { notFound } from "next/navigation";
import { AccountWorkspace } from "@/components/marketplace/account-workspace";
import { SignInGate } from "@/components/marketplace/session";
import { NotificationInbox } from "@/components/notification-inbox";
import { notificationInbox } from "@/lib/notifications/inbox";
import { getShopper } from "@/lib/marketplace/auth";
import { marketplaceMode } from "@/lib/release-config";
import { currentMarket } from "@/lib/market-server";

export const metadata = { title: "Notifications", robots: { index: false, follow: false } };

export default async function AccountNotifications() {
  if (!marketplaceMode()) notFound();
  const [shopper, market] = await Promise.all([getShopper(), currentMarket()]);
  return <AccountWorkspace title="Notifications" market={market} active="/account/notifications">
    {shopper ? <NotificationInbox audience="customer" marketId={market.id}
      items={await notificationInbox({ audience: "customer", actorId: shopper.id, marketId: market.id })}/>
      : <SignInGate>Sign in to see your order notifications.</SignInGate>}
  </AccountWorkspace>;
}
