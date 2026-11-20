import { notFound } from "next/navigation";
import { marketplaceMode } from "@/lib/release-config";
import { getShopper } from "@/lib/marketplace/auth";
import { threadsFor } from "@/lib/marketplace/data";
import { ThreadLinks } from "@/components/marketplace/messages";
import { SignInGate } from "@/components/marketplace/session";

export const metadata = { title: "Messages" };

export default async function MessagesPage() {
  if (!marketplaceMode()) notFound();
  const shopper = await getShopper();
  return <div className="shell mp-page"><h1 className="mp-page-title">Messages</h1>
    {shopper ? <ThreadLinks rows={await threadsFor(shopper.id)}/> : <SignInGate>Sign in to see your conversations.</SignInGate>}
  </div>;
}
