import Link from "next/link";
import { notFound } from "next/navigation";
import { WorkspaceCommandForm } from "@/components/marketplace/workspace-command-form";
import { currentMarket } from "@/lib/market-server";
import { selectableMarkets } from "@/lib/market-config";
import { sellerVerificationLabels, sellerVerificationQueue, sellerVerificationTestMode } from "@/lib/marketplace/seller-market-profile";
import { requireStaff } from "@/lib/staff/access";
import "@/components/marketplace/workspace-command.css";

export const metadata = { title: "Seller verification" };

export default async function SellerVerification({ searchParams }: { searchParams: Promise<{ page?: string; market?: string }> }) {
  const [staff, market, query] = await Promise.all([requireStaff(), currentMarket(), searchParams]);
  if (staff.role !== "OWNER" || query.market !== undefined && query.market !== market.id) notFound();
  const page = /^[1-9]\d{0,3}$/.test(query.page ?? "") ? Number(query.page) : 1;
  const workspace = sellerVerificationTestMode() ? await sellerVerificationQueue(staff.id, market.id, page) : null;
  const endpoint = `/api/staff/seller-verification?market=${market.id}`;
  return <>
    <header className="page-intro"><h1>Seller verification</h1><p>{market.name} · Test review</p></header>
    <nav className="mp-panel-links" aria-label="Verification market">
      {selectableMarkets().map(option => <Link key={option.id} href={`/staff/seller-verification?market=${option.id}`}
        aria-current={market.id === option.id ? "page" : undefined}>{option.name}</Link>)}
    </nav>
    {!workspace ? <p>Business verification is unavailable in this environment.</p> : <>
      <section className="mp-panel">
        <h2>Verification form</h2>
        <p>{workspace.form ? `Published version ${workspace.form.version}` : "No form is published."} Use synthetic business information only.</p>
        <WorkspaceCommandForm endpoint={endpoint} action="verification.form" submit="Publish test form"
          values={{ previousVersion: workspace.form?.version ?? 0 }} key={workspace.form?.version}>
          {Object.entries(sellerVerificationLabels).map(([name, label]) => <label key={name}>
            <input type="checkbox" name="fields" value={name} defaultChecked={workspace.form?.fields.some(field => field === name) ?? name === "businessName"}/>
            {label}
          </label>)}
        </WorkspaceCommandForm>
      </section>
      <section className="mp-panel">
        <h2>Business submissions</h2>
        {workspace.rows.length === 0 && <p>No submissions for this market.</p>}
        {workspace.rows.map(row => <article key={row.id} className="seller-settings-address">
          <h3>{row.grant.shop.name}</h3>
          <p>Form {row.version} · {row.state === "SUBMITTED" ? "Awaiting review" : row.state === "ACCEPTED" ? "Accepted in test" : "Revision requested"}</p>
          <dl>{Object.entries(row.answers ?? {}).flatMap(([name, value]) => name in sellerVerificationLabels && typeof value === "string"
            ? [<div key={name}><dt>{sellerVerificationLabels[name as keyof typeof sellerVerificationLabels]}</dt><dd>{value}</dd></div>] : [])}</dl>
          {row.note && <p>{row.note}</p>}
          {row.state === "SUBMITTED" && <WorkspaceCommandForm endpoint={endpoint} action="verification.review" submit="Save review"
            values={{ id: row.id }}>
            <label>Decision<select name="decision"><option value="ACCEPTED">Accept test verification</option><option value="DECLINED">Request revision</option></select></label>
            <label>Message to seller<textarea name="note" maxLength={400} required rows={2}/></label>
          </WorkspaceCommandForm>}
        </article>)}
        <nav className="mp-panel-links" aria-label="Verification pages">
          {page > 1 && <Link href={`/staff/seller-verification?market=${market.id}&page=${page - 1}`}>Previous submissions</Link>}
          {workspace.hasNext && <Link href={`/staff/seller-verification?market=${market.id}&page=${page + 1}`}>Next submissions</Link>}
        </nav>
      </section>
    </>}
  </>;
}
