import Link from "next/link";
import { notFound } from "next/navigation";
import { isMarketId, markets, type MarketId } from "@/config/markets";
import { orderDate } from "@/lib/commerce/labels";
import { caseKindLabels, caseStatusLabels } from "@/lib/marketplace/case-policy";
import { listOrderCases } from "@/lib/marketplace/cases";
import { marketplaceMode } from "@/lib/release-config";
import { requireStaff } from "@/lib/staff/access";

export const metadata = { title: "Order cases" };

export default async function OrderCasesPage({ searchParams }: { searchParams: Promise<{ filter?: string; page?: string; market?: string }> }) {
  if (!marketplaceMode()) notFound();
  const [staff, query] = await Promise.all([requireStaff(), searchParams]);
  if (staff.role !== "OWNER") notFound();
  const market = query.market;
  if (market !== undefined && (!isMarketId(market) || !staff.marketIds.includes(market))) notFound();
  const all = query.filter === "all";
  const pageNumber = Number(query.page);
  const page = Number.isInteger(pageNumber) && pageNumber > 0 && pageNumber <= 10_000 ? pageNumber : 1;
  const { rows, hasNext } = await listOrderCases(staff.id, all, page, market);
  const pageLink = (next: number, includeClosed = all, selected: MarketId | null = market ?? null) => "/staff/cases?" +
    new URLSearchParams({ filter: includeClosed ? "all" : "active", page: String(next), ...(selected && { market: selected }) });

  return (<>
    <div className="commerce-intro">
      <h1 className="display-type">Order cases</h1>
      <p>Review return requests and disputes from shoppers.</p>
    </div>
    <nav className="staff-filters" aria-label="Case filters">
      <Link href={pageLink(1, false)} aria-current={!all ? "page" : undefined}>Active cases</Link>
      <Link href={pageLink(1, true)} aria-current={all ? "page" : undefined}>All cases</Link>
    </nav>
    <nav className="staff-filters" aria-label="Case markets">
      <Link href={pageLink(1, all, null)} aria-current={!market ? "page" : undefined}>All granted markets</Link>
      {staff.marketIds.map(id => <Link key={id} href={pageLink(1, all, id)} aria-current={market === id ? "page" : undefined}>{markets[id].name}</Link>)}
    </nav>
    <section className="commerce-panel">
      <h2>{all ? "All cases" : "Active cases"}</h2>
      {rows.length ? (
        <ul className="mp-editor-list">
          {rows.map(row => (
            <li key={row.id}>
              <Link href={`/staff/cases/${row.id}?market=${row.order.marketId}`}>
                {row.order.reference} · {markets[row.order.marketId].name} · {caseKindLabels[row.kind]} · {caseStatusLabels[row.status]}
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
