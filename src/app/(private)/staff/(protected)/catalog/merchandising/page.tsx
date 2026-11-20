import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { requireStaff } from "@/lib/staff/access";
import { approvalCurrent, candidates, readiness } from "@/lib/staff/merchandising";
import { merchandisingEnabled } from "@/lib/staff/merchandising-config";
import { BatchForm, SourceForms } from "@/components/merchandising-forms";
import "./merchandising.css";

export const metadata = { title: "Merchandising", robots: { index: false, follow: false } };

export default async function MerchandisingPage() {
  const staff = await requireStaff();
  if (staff.role !== "OWNER" || !merchandisingEnabled()) notFound();
  const values = await candidates(staff.id);
  const rows = [];
  for (const view of values) rows.push({ view, checks: await readiness(getDb(), view) });
  return <>
    <div className="commerce-intro"><Link className="text-link" href="/staff/catalog">Catalog</Link>
      <h1 className="display-type">Merchandising</h1>
    </div>
    <div className="merch-stack">
      <SourceForms />
      <section className="commerce-panel">
        <h2>Catalog candidates</h2>
        {rows.length === 0 ? <p>No candidates yet.</p> : <BatchForm>
          <ul className="merch-list">
            {rows.map(({ view, checks }) => {
              const approved = approvalCurrent(view, checks);
              const selectable = checks.ready && view.decision === "pending";
              const scope = checks.markets.filter((item) => item.ready).map((item) => item.market).join(",");
              const status = view.publishedAt ? "Published to staging" : view.decision === "rejected" ? "Rejected" :
                approved ? view.stagedRevision === view.revision ? "Catalog draft saved" : "Approved" :
                  view.decision === "approved" ? "Approval needs refresh" : selectable ? "Ready for review" : "Needs information";
              return <li key={view.id}>
                <label><input aria-label={`Select ${view.draft.product.name}`} type="checkbox" name="selection"
                  value={`${view.id}:${view.revision}:${scope}`} disabled={!selectable} /></label>
                <div><Link className="staff-order-ref" href={`/staff/catalog/merchandising/${view.id}`}>{view.draft.product.name}</Link>
                  <p>{view.source.supplier} · {view.source.externalId} · {view.draft.product.variants.length} variant{s(view.draft.product.variants.length)}</p></div>
                <span className="staff-status">{status}</span>
              </li>;
            })}
          </ul>
        </BatchForm>}
      </section>
    </div>
  </>;
}

function s(count: number) { return count === 1 ? "" : "s"; }
