import Link from "next/link";
import { notFound } from "next/navigation";
import { getShopper } from "@/lib/marketplace/auth";
import { getStaff } from "@/lib/staff/access";
import { userThread } from "@/lib/marketplace/data";
import { marketplaceMode } from "@/lib/release-config";
import { uuid } from "@/lib/commerce/checkout-types";
import { CloseThread, ReplyForm } from "@/components/marketplace/messages";

export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!marketplaceMode() || !uuid.safeParse(id).success) notFound();
  const [shopper, staff] = await Promise.all([getShopper(), getStaff()]);
  const viewer = { shopperId: shopper?.id, staffOwner: staff?.role === "OWNER" };
  const thread = await userThread(id, viewer);
  if (!thread) notFound();
  const buyer = thread.shopperId === shopper?.id;
  return <div className="shell mp-page">
    <p className="mp-panel-links"><Link href={buyer ? "/messages" : viewer.staffOwner ? "/staff/marketplace" : "/seller"}>Back to messages</Link></p>
    <h1 className="mp-page-title">{thread.subject}</h1>
    <p className="mp-lead">{thread.shop.name}{thread.order && ` · ${thread.order.reference}`}{thread.closed && " · Closed"}</p>
    <ol className="mp-section">{[...thread.messages].reverse().map(message => <li key={message.id} className="mp-message" data-shop={message.fromShop}>
      <strong>{message.fromShop ? thread.shop.name : buyer ? "You" : "Buyer"}</strong><p>{message.text}</p>
      <time dateTime={message.createdAt.toISOString()}>{message.createdAt.toLocaleString("en-GB", { timeZone: "Asia/Dhaka" })}</time>
    </li>)}</ol>
    {!thread.closed && <><ReplyForm thread={id}/><details className="mp-section"><summary>Manage conversation</summary><CloseThread thread={id}/></details></>}
  </div>;
}
