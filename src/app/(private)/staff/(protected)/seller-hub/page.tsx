import Link from "next/link";
import { notFound } from "next/navigation";
import { WorkspaceCommandForm } from "@/components/marketplace/workspace-command-form";
import { currentMarket } from "@/lib/market-server";
import { selectableMarkets } from "@/lib/market-config";
import { hubSections, type HubSection, type HubRecordView } from "@/lib/marketplace/seller-hub";
import { marketplaceMode } from "@/lib/release-config";
import { requireStaff } from "@/lib/staff/access";
import { staffSellerHubWorkspace } from "@/lib/staff/seller-hub-workspace";
import "@/components/marketplace/workspace-command.css";

export const metadata = { title: "Seller Hub" };

const titles: Record<HubSection, string> = {
  notices: "Notices", requests: "Seller requests", campaigns: "Campaign invitations", conversations: "Seller conversations",
};

function SellerRecipient({ shops, required }: { shops: { id: string; name: string }[]; required?: boolean }) {
  return <label>Seller organization<select name="shopId" required={required}>
    <option value="">Choose an approved seller</option>
    {shops.map(shop => <option key={shop.id} value={shop.id}>{shop.name}</option>)}
  </select></label>;
}

function HubReview({ item, endpoint }: { item: HubRecordView; endpoint: string }) {
  return <section className="mp-panel">
    <h2>{item.title}</h2>
    <p>{item.shopName ?? (item.scope === "PLATFORM" ? "Platform-wide" : "Selected market")} · {item.status.toLowerCase()}</p>
    {item.body && <p>{item.body}</p>}
    {item.reference && <p>Campaign {item.reference}</p>}
    {item.posts.length > 0 && <ol className="seller-activity">{item.posts.map(post => <li key={post.id}>
      <div><strong>{post.from === "STAFF" ? "Staff" : "Seller"}</strong><p>{post.text}</p></div>
    </li>)}</ol>}
    {item.kind === "REQUEST" && item.status === "OPEN" && <WorkspaceCommandForm endpoint={endpoint}
      action="request.review" operationKey="operationId" values={{ id: item.id }} submit="Save decision">
      <label>Decision<select name="decision"><option value="ACCEPTED">Accept for follow-up</option><option value="DECLINED">Decline</option></select></label>
      <label>Decision note<textarea name="note" rows={3} maxLength={500} required/></label>
    </WorkspaceCommandForm>}
    {item.kind === "CONVERSATION" && <WorkspaceCommandForm endpoint={endpoint}
      action="conversation.reply" operationKey="operationId" values={{ id: item.id }} submit="Save reply">
      <label>Reply<textarea name="text" rows={3} required maxLength={1800}/></label>
    </WorkspaceCommandForm>}
  </section>;
}

export default async function StaffSellerHub({ searchParams }: {
  searchParams: Promise<{ market?: string; tab?: string; id?: string; page?: string; q?: string; template?: string }>;
}) {
  if (!marketplaceMode()) notFound();
  const [staff, market, query] = await Promise.all([requireStaff(), currentMarket(), searchParams]);
  if (staff.role !== "OWNER" || query.market !== undefined && query.market !== market.id) notFound();
  const section = hubSections.find(value => value === query.tab) ?? "notices";
  const page = /^[1-9]\d{0,3}$/.test(query.page ?? "") ? Number(query.page) : 1;
  const q = typeof query.q === "string" ? query.q.trim().slice(0, 80) : "";
  const data = await staffSellerHubWorkspace(market.id, section, page, query.id ?? query.template, q);
  const selected = query.id ? data.detail : null;
  const template = query.template && !query.id && data.detail?.kind === "NOTICE" ? data.detail : null;
  const endpoint = `/api/staff/seller-hub?market=${market.id}`;
  const href = (key: HubSection, target?: Record<string, string>) =>
    `/staff/seller-hub?${new URLSearchParams({ market: market.id, tab: key, ...(q && { q }), ...target })}`;

  return <>
    <header className="page-intro"><h1>Seller Hub</h1><p>{market.name} · Seller communications</p></header>
    <nav className="mp-panel-links" aria-label="Seller Hub market">
      {selectableMarkets().map(option => <Link key={option.id} href={`/staff/seller-hub?market=${option.id}&tab=${section}`}
        aria-current={market.id === option.id ? "page" : undefined}>{option.name}</Link>)}
    </nav>
    <nav className="mp-panel-links" aria-label="Seller Hub sections">
      {hubSections.map(key => <Link key={key} href={href(key)} aria-current={section === key ? "page" : undefined}>{titles[key]}</Link>)}
    </nav>
    {section !== "requests" && <section className="mp-panel">
      <h2>{section === "notices" ? "Publish notice" : section === "campaigns" ? "Invite a seller" : "Start conversation"}</h2>
      <form method="get" className="mp-inline">
        <input type="hidden" name="market" value={market.id}/><input type="hidden" name="tab" value={section}/>
        <label>Find an approved seller<input type="search" name="q" defaultValue={q} maxLength={80}/></label>
        <button className="button button--outline">Find sellers</button>
      </form>
      <WorkspaceCommandForm key={section + (template?.id ?? "")} endpoint={endpoint} operationKey="operationId"
        action={section === "notices" ? "notice.publish" : section === "campaigns" ? "campaign.invite" : "conversation.start"}
        submit={section === "notices" ? "Publish in Seller Hub" : section === "campaigns" ? "Save invitation" : "Save conversation"}>
        {section === "notices" && <label>Recipient scope<select name="scope">
          <option value="MARKET">All approved sellers in this market</option>
          <option value="SHOP">One approved seller</option><option value="PLATFORM">All approved markets</option>
        </select></label>}
        <SellerRecipient shops={data.shops} required={section !== "notices"}/>
        {section === "campaigns" && <label>Existing promotion code<input name="reference" required maxLength={60}/></label>}
        <label>Title<input name="title" required maxLength={120} defaultValue={template?.title}/></label>
        <label>{section === "conversations" ? "Message" : "Details"}<textarea name={section === "conversations" ? "text" : "body"}
          required rows={4} maxLength={1800} defaultValue={template?.body}/></label>
      </WorkspaceCommandForm>
      <p>Updates are saved in Seller Hub. Email, SMS and push are separate delivery channels.</p>
    </section>}
    {selected && <HubReview item={selected} endpoint={endpoint}/>}
    {query.id && !selected && <p role="status">This record is unavailable in the selected market.</p>}
    <section className="mp-panel">
      <h2>{titles[section]}</h2>
      {!data.rows.length && <p>No records for this market.</p>}
      <ul className="seller-activity">{data.rows.map(item => <li key={item.id}>
        <div><strong><Link href={href(section, { id: item.id })}>{item.title}</Link></strong>
          <p>{item.shopName ?? (item.scope === "PLATFORM" ? "Platform-wide" : market.name)} · {item.status.toLowerCase()}</p></div>
        {item.kind === "NOTICE" && <Link href={href(section, { template: item.id })}>Use as draft</Link>}
      </li>)}</ul>
      <nav className="mp-panel-links" aria-label="Seller Hub pages">
        {page > 1 && <Link href={href(section, { page: String(page - 1) })}>Previous records</Link>}
        {data.hasNext && <Link href={href(section, { page: String(page + 1) })}>Next records</Link>}
      </nav>
    </section>
  </>;
}
