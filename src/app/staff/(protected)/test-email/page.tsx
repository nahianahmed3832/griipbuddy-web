import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { shopperMailPreview, shopperMailPreviewCutoff, shopperMailSupports } from "@/lib/commerce/shopper-mail";
import { orderDate } from "@/lib/commerce/labels";
import { getDb } from "@/lib/db/client";
import { requireStaff } from "@/lib/staff/access";

export const metadata: Metadata = { title: "Test email inbox", robots: { index: false, follow: false }, referrer: "no-referrer" };

function testLink(text: string | null) {
  const origin = process.env.BETTER_AUTH_URL;
  if (!origin || !text) return;
  for (const line of text.split("\n")) {
    try {
      const url = new URL(line.trim().replace(/^(?:Track your order|Sign in to view your order|অর্ডার ট্র্যাক করুন|অর্ডার দেখতে সাইন ইন করুন): /, ""));
      if (url.origin === new URL(origin).origin && /^\/(?:bd\/)?(?:account\/(?:verify-email|reset-password)$|orders(?:\/|$))/.test(url.pathname)) {
        return url.href;
      }
    } catch {
      // Ignore lines which are not links.
    }
  }
}

export default async function TestEmailPage({ searchParams }: { searchParams: Promise<{ to?: string | string[] }> }) {
  if (!shopperMailPreview()) notFound();
  const staff = await requireStaff();
  if (staff.role !== "OWNER") notFound();
  const { to } = await searchParams;
  const recipient = typeof to === "string" ? to.trim().toLowerCase().slice(0, 254) : "";
  const supported = shopperMailSupports(recipient);
  const messages = supported ? await getDb().shopperMailRecord.findMany({
    where: { recipient, status: "CAPTURED", createdAt: { gte: shopperMailPreviewCutoff() } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 40,
  }) : [];

  return <div className="commerce-stack">
    <div className="commerce-intro">
      <h1 className="display-type">Test email inbox</h1>
      <p>View messages captured for a test address on dev.</p>
    </div>
    <form method="get" className="commerce-panel commerce-form">
      <label>Test recipient<input type="email" name="to" placeholder="shopper@example.invalid" maxLength={254} defaultValue={recipient} required /></label>
      <button type="submit" className="button button--primary">Find messages</button>
    </form>
    {recipient && !supported && <p role="alert">Enter a test address ending in @example.invalid.</p>}
    {supported && !messages.length && <p role="status">No recent test messages for this address.</p>}
    {messages.map(message => {
      const link = testLink(message.text);
      return <section key={message.id} className="commerce-panel" data-mail-kind={message.kind}>
        <h2>{message.subject}</h2>
        <p>{message.recipient} · <time dateTime={message.createdAt.toISOString()}>{orderDate(message.createdAt)}</time></p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.text}</pre>
        {link && <a className="button button--outline" href={link} referrerPolicy="no-referrer">Open test link</a>}
      </section>;
    })}
  </div>;
}
