import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { ConfirmCaseRefund, ReviewOrderCase, StaffCaseReply } from "@/components/marketplace/case-forms";
import { CaseHistory } from "@/components/marketplace/case-panels";
import { Breadcrumbs } from "@/components/store-ui";
import { isMarketId, markets } from "@/config/markets";
import { caseKindLabels, caseStatusLabels } from "@/lib/marketplace/case-policy";
import { staffOrderCase } from "@/lib/marketplace/cases";
import { marketplaceMode } from "@/lib/release-config";
import { requireStaff } from "@/lib/staff/access";

export const metadata = { title: "Review order case" };

export default async function StaffCasePage({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Promise<{ market?: string }> }) {
  if (!marketplaceMode()) notFound();
  const [staff, { caseId }, { market }] = await Promise.all([requireStaff(), params, searchParams]);
  if (staff.role !== "OWNER" || !z.uuid().safeParse(caseId).success) notFound();
  if (market !== undefined && !isMarketId(market)) notFound();
  const orderCase = await staffOrderCase(staff.id, caseId, market);
  if (!orderCase) notFound();
  const label = caseKindLabels[orderCase.kind];
  const { id, kind, status, revision, returnLines } = orderCase;
  const formState = { id, kind, status, revision, returnLineCount: returnLines.length };

  return (<>
    <Breadcrumbs items={[{ label: "Order cases", href: "/staff/cases" }, { label }]} />
    <div className="commerce-intro">
      <h1 className="display-type">{label}</h1>
      <p>Order <Link href={`/staff/orders/${orderCase.order.id}`}>{orderCase.order.reference}</Link> · {markets[orderCase.order.marketId].name} · {caseStatusLabels[orderCase.status]}</p>
      <p>Case reference <span className="break-all">{caseId}</span></p>
    </div>
    <div className="commerce-stack">
      <CaseHistory orderCase={orderCase} staff />
      {orderCase.returnDisposition && (
        <section className="commerce-panel">
          <h2>Return receipt</h2>
          <p>{orderCase.returnDisposition === "RESTOCK" ? "The listed items were restored to available stock."
            : "The listed items are held for review. Available stock did not change."}</p>
          <p>Order payment and any courier remittance are unchanged.</p>
        </section>
      )}
      {orderCase.refundReference && <p className="commerce-panel">Payout confirmation reference · {orderCase.refundReference}</p>}
      <ConfirmCaseRefund orderCase={formState} limitMinor={orderCase.maxRefundMinor} />
      <ReviewOrderCase orderCase={formState} market={orderCase.order.marketId} />
      <StaffCaseReply orderCase={formState} market={orderCase.order.marketId} />
    </div>
  </>);
}
