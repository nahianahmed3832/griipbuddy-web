import Link from "next/link";
import { notFound } from "next/navigation";
import { getShopper } from "@/lib/marketplace/auth";
import { getStaff } from "@/lib/staff/access";
import { userThread } from "@/lib/marketplace/data";
import { marketplaceMode } from "@/lib/release-config";
import { currentMarket } from "@/lib/market-server";
import { orderDate } from "@/lib/commerce/labels";
import { uuid } from "@/lib/commerce/checkout-types";
import { CloseThread, ReplyForm } from "@/components/marketplace/messages";

export const metadata = { title: "Conversation", robots: { index: false, follow: false } };

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!marketplaceMode() || !uuid.safeParse(id).success) notFound();
  const [shopper, staff, market] = await Promise.all([getShopper(), getStaff(), currentMarket()]);
  const viewer = { shopperId: shopper?.id, staffOwner: staff?.role === "OWNER", marketId: market.id };
  const thread = await userThread(id, viewer);
  if (!thread) notFound();
  const buyer = thread.viewerSide === "buyer";
  return <div className="shell mp-page" data-clarity-mask="true">
    <p className="mp-panel-links"><Link href={buyer ? "/messages" : thread.viewerSide === "staff" ? "/staff/marketplace" : `/messages?market=${market.id}&seller=1&shop=${thread.shop.id}`}>Back to messages</Link></p>
    <h1 className="mp-page-title">{thread.subject}</h1>
    <p className="mp-lead">{thread.shop.name}{thread.product && ` · ${thread.product.name}`}{thread.order && ` · ${thread.order.reference}`}{thread.closed && " · Closed"}</p>
    <ol className="mp-section">{[...thread.messages].reverse().map(message => <li key={message.id} className="mp-message" data-shop={message.fromShop}>
      <strong>{message.fromShop ? thread.shop.name : buyer ? "You" : "Buyer"}</strong><p>{message.text}</p>
      <time dateTime={message.createdAt.toISOString()}>{orderDate(message.createdAt, market.id)}</time>
    </li>)}</ol>
    {!thread.closed && <><ReplyForm thread={id}/><details className="mp-section"><summary>Manage conversation</summary><CloseThread thread={id}/></details></>}
  </div>;
}
