import Link from "next/link";
import { notFound } from "next/navigation";
import { caseProgressLabel } from "@/components/marketplace/case-panels";
import { orderDate } from "@/lib/commerce/labels";
import { caseKindLabels } from "@/lib/marketplace/case-policy";
import { listOrderCases } from "@/lib/marketplace/cases";
import { marketplaceMode } from "@/lib/release-config";
import { requireStaff } from "@/lib/staff/access";

export const metadata = { title: "Order cases" };

export default async function OrderCasesPage({ searchParams }: { searchParams: Promise<{ filter?: string; page?: string }> }) {
  if (!marketplaceMode()) notFound();
  const [staff, query] = await Promise.all([requireStaff(), searchParams]);
  if (staff.role !== "OWNER") notFound();
  const all = query.filter === "all";
  const pageNumber = Number(query.page);
  const page = Number.isInteger(pageNumber) && pageNumber > 0 && pageNumber <= 10_000 ? pageNumber : 1;
  const { rows, hasNext } = await listOrderCases(staff.id, all, page);
  const pageLink = (next: number) => `/staff/cases?filter=${all ? "all" : "active"}&page=${next}`;

  return (<>
    <div className="commerce-intro">
      <h1 className="display-type">Order cases</h1>
      <p>Review cancellations, returns, exchanges and order disputes.</p>
    </div>
    <nav className="staff-filters" aria-label="Case filters">
      <Link href="/staff/cases" aria-current={!all ? "page" : undefined}>Active cases</Link>
      <Link href="/staff/cases?filter=all" aria-current={all ? "page" : undefined}>All cases</Link>
    </nav>
    <section className="commerce-panel">
      <h2>{all ? "All cases" : "Active cases"}</h2>
      {rows.length ? (
        <ul className="mp-editor-list">
          {rows.map(row => (
            <li key={row.id}>
              <Link href={`/staff/cases/${row.id}`}>
                {row.order.reference} · {caseKindLabels[row.kind]} · {caseProgressLabel(row.kind, row.status)}
              </Link>{" "}<time dateTime={row.updatedAt.toISOString()}>{orderDate(row.updatedAt, row.order.marketId)}</time>
            </li>
          ))}
        </ul>
      ) : <p>{all ? "No cases to display." : "No active cases on this page."}</p>}
      {(page > 1 || hasNext) && <nav className="mp-panel-links" aria-label="Case pages">
        {page > 1 && <Link href={pageLink(page - 1)}>Previous</Link>}
        <span>Page {page}</span>
        {hasNext && <Link href={pageLink(page + 1)}>Next</Link>}
      </nav>}
    </section>
  </>);
}
