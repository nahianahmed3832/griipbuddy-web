import Link from "next/link";
import { notFound } from "next/navigation";
import { SellerPageHeader, SellerEmpty, SellerPager, SellerStatus } from "@/components/marketplace/seller-ui";
import { SellerHubForm } from "@/components/marketplace/seller-hub-form";
import { SignInGate } from "@/components/marketplace/session";
import { currentMarket } from "@/lib/market-server";
import { orderDate } from "@/lib/commerce/labels";
import { getShopper } from "@/lib/marketplace/auth";
import { resolveSellerAccess } from "@/lib/marketplace/seller-access";
import { hubSections, sellerHubDetail, sellerHubPage, type HubRecordView, type HubSection } from "@/lib/marketplace/seller-hub";
import { firstPartyStoreMode } from "@/lib/release-config";
import styles from "./hub.module.css";

export const metadata = { title: "Seller Hub", robots: { index: false, follow: false } };

const sectionLabels = { notices: "Notices", requests: "Requests", campaigns: "Campaigns", conversations: "Marketplace messages" };
const statusLabels = { OPEN: "Awaiting review", ACCEPTED: "Accepted", DECLINED: "Declined" };
const descriptions = {
  notices: "Marketplace announcements and policy updates.",
  requests: "Ask Marketplace staff to review a category, brand or other shop request.",
  campaigns: "Review invitations for this shop and market.",
  conversations: "Messages between your shop and Marketplace staff.",
};
type Query = { market?: string | string[]; shop?: string | string[]; view?: string | string[]; record?: string | string[]; page?: string | string[] };

function RecordStatus({ row }: { row: HubRecordView }) {
  return <div className="seller-actions">
    {!row.seen && <SellerStatus tone="warning">Unread</SellerStatus>}
    {row.kind === "NOTICE" && <SellerStatus tone={row.acknowledged ? "positive" : "muted"}>
      {row.acknowledged ? "Acknowledged" : row.scope === "SHOP" ? "Your shop" : row.scope === "MARKET" ? "This market" : "All shops"}
    </SellerStatus>}
    {row.kind === "REQUEST" && <SellerStatus tone={row.status === "OPEN" ? "warning" : "muted"}>{statusLabels[row.status]}</SellerStatus>}
    {row.kind === "CAMPAIGN" && <SellerStatus tone={row.status === "OPEN" ? "warning" : "muted"}>
      {row.status === "OPEN" ? "Awaiting response" : row.status === "ACCEPTED" ? "Interested" : "Declined"}
    </SellerStatus>}
  </div>;
}

export default async function Hub({ searchParams }: { searchParams: Promise<Query> }) {
  if (firstPartyStoreMode()) notFound();
  const [query, market, shopper] = await Promise.all([searchParams, currentMarket(), getShopper()]);
  if (query.market !== undefined && query.market !== market.id || Array.isArray(query.shop) || Array.isArray(query.record)) notFound();
  const view = typeof query.view === "string" && hubSections.includes(query.view as HubSection) ? query.view as HubSection : "notices";
  if (!shopper) return <div className="seller-entry"><SellerPageHeader title="Seller Hub"/><SignInGate>
    Sign in to open the seller inbox.
  </SignInGate></div>;
  const access = await resolveSellerAccess(shopper.id, market.id, "SUPPORT", query.shop);
  if (!access) return <div className="seller-entry"><SellerPageHeader title="Seller Hub"/>
    <SellerEmpty title="Seller Hub is unavailable in this market">Contact the shop owner if you need support access. <Link
      href={`/seller/team?market=${market.id}`}>View team invitations</Link></SellerEmpty></div>;
  const shop = access.shop;
  const actor = { shopId: shop.id, shopperId: shopper.id, marketId: market.id };
  const page = typeof query.page === "string" && /^\d{1,4}$/u.test(query.page) ? Math.max(1, Number(query.page)) : 1;
  const href = (section: HubSection, params?: Record<string, string>) => `/seller/hub?${new URLSearchParams({
    market: market.id, shop: shop.id, view: section, ...params,
  })}`;
  const [listing, detail] = await Promise.all([
    sellerHubPage(actor, view, page), query.record ? sellerHubDetail(actor, query.record) : null,
  ]);
  if (query.record && !detail) notFound();
  const formScope = { section: "hub" as const, market: market.id };
  const command = (action: string, further?: Record<string,string>) => ({ action, shopId: shop.id, ...further });

  return <>
    <SellerPageHeader title="Seller Hub" description={`${shop.name} · ${market.name}`}
      actions={<Link href={`/messages?market=${market.id}&shop=${shop.id}&seller=1`} className="seller-button" prefetch={false}>Buyer conversations</Link>}/>
    <nav aria-label="Seller Hub sections" className={styles.tabs}>
      {hubSections.map(section => <Link href={href(section)} key={section} className="seller-button"
        aria-current={view === section ? "page" : undefined} prefetch={false}>{sectionLabels[section]}</Link>)}
    </nav>
    {detail && <section className="seller-panel" aria-labelledby="hub-record-title">
      <div className="seller-panel-heading"><div><h2 id="hub-record-title">{detail.title}</h2>
        <p className="seller-muted">{orderDate(detail.updatedAt, market.id)}</p></div><RecordStatus row={detail}/></div>
      {detail.body && <p className={styles.body}>{detail.body}</p>}
      {detail.posts.length > 0 && <ol className={styles.posts}>{detail.posts.map(post => <li key={post.id}>
        <strong>{post.from === "STAFF" ? "Marketplace team" : shop.name}</strong>
        <time className="seller-muted" dateTime={post.createdAt.toISOString()}>{orderDate(post.createdAt, market.id)}</time>
        <p>{post.text}</p>
      </li>)}</ol>}
      <div className={styles.recordActions}>
        {!detail.seen && <SellerHubForm {...formScope} command={command("record.read", { id: detail.id })}
          label="Mark as read" success="Marked as read."/>}
        {detail.kind === "NOTICE" && !detail.acknowledged && <SellerHubForm {...formScope}
          command={command("notice.acknowledge", { id: detail.id })} label="Acknowledge notice" success="Acknowledgement saved."/>}
        {detail.kind === "CAMPAIGN" && detail.status === "OPEN" && <>
          <SellerHubForm {...formScope} command={command("campaign.respond", { id: detail.id, decision: "ACCEPTED" })}
            label="Express interest" success="Interest recorded."/>
          <SellerHubForm {...formScope} command={command("campaign.respond", { id: detail.id, decision: "DECLINED" })}
            label="Decline" success="Response recorded."/>
        </>}
      </div>
      {detail.kind === "CONVERSATION" && <SellerHubForm {...formScope} command={command("conversation.reply", { id: detail.id })}
        label="Save reply" success="Reply saved in the Hub." reset>
        <label>Reply<textarea name="text" rows={4} maxLength={4000} required/></label>
      </SellerHubForm>}
    </section>}
    <section className="seller-panel" aria-labelledby="seller-hub-list">
      <div className="seller-panel-heading"><div><h2 id="seller-hub-list">{sectionLabels[view]}</h2>
        <p className="seller-muted">{descriptions[view]}</p></div></div>
      {!listing.rows.length ? <SellerEmpty title={`No ${sectionLabels[view].toLowerCase()} yet`}/> :
        <ul className={styles.rows}>{listing.rows.map(row => <li key={row.id}>
          <Link href={href(view, { record: row.id })} prefetch={false}>{row.title}</Link>
          <RecordStatus row={row}/><time className="seller-muted" dateTime={row.updatedAt.toISOString()}>{orderDate(row.updatedAt, market.id)}</time>
        </li>)}</ul>}
      <SellerPager page={page} hasNext={listing.hasNext} label="Seller Hub pages" pageHref={p => href(view, { page: String(p) })}/>
    </section>
    {view === "requests" && <section className="seller-panel" aria-labelledby="new-seller-request">
      <div className="seller-panel-heading"><h2 id="new-seller-request">Submit a request</h2></div>
      <SellerHubForm {...formScope} command={command("request.submit")} label="Submit for review" success="Request submitted." reset>
        <label>Request type<select name="category" required><option value="CATEGORY">Category</option>
          <option value="BRAND">Brand</option><option value="OTHER">Other</option></select></label>
        <label>Subject<input name="title" maxLength={120} required/></label>
        <label>What should Marketplace review?<textarea name="body" rows={4} maxLength={4000} required/></label>
      </SellerHubForm>
    </section>}
    {view === "conversations" && <section className="seller-panel" aria-labelledby="new-marketplace-message">
      <div className="seller-panel-heading"><h2 id="new-marketplace-message">Message Marketplace staff</h2></div>
      <SellerHubForm {...formScope} command={command("conversation.start")} label="Save message" success="Message saved in the Hub." reset>
        <label>Subject<input name="title" maxLength={120} required/></label>
        <label>Message<textarea name="text" rows={4} maxLength={4000} required/></label>
      </SellerHubForm>
    </section>}
  </>;
}
