import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { CaseHistory, caseProgressLabel } from "@/components/marketplace/case-panels";
import { ReviewOrderCase } from "@/components/marketplace/case-staff-forms";
import { Breadcrumbs } from "@/components/store-ui";
import { caseKindLabels } from "@/lib/marketplace/case-policy";
import { staffOrderCase } from "@/lib/marketplace/cases";
import { marketplaceMode } from "@/lib/release-config";
import { requireStaff } from "@/lib/staff/access";
import { marketConfiguration } from "@/lib/market-config";

export const metadata = { title: "Review order case" };

export default async function StaffCasePage({ params }: { params: Promise<{ caseId: string }> }) {
  if (!marketplaceMode()) notFound();
  const [staff, { caseId }] = await Promise.all([requireStaff(), params]);
  if (staff.role !== "OWNER" || !z.uuid().safeParse(caseId).success) notFound();
  const orderCase = await staffOrderCase(staff.id, caseId);
  if (!orderCase) notFound();
  const label = caseKindLabels[orderCase.kind];

  return (<>
    <Breadcrumbs items={[{ label: "Order cases", href: "/staff/cases" }, { label }]} />
    <div className="commerce-intro">
      <h1 className="display-type">{label}</h1>
      <p>Order <Link href={`/staff/orders/${orderCase.order.id}`}>{orderCase.order.reference}</Link> · {caseProgressLabel(orderCase.kind, orderCase.status)}</p>
    </div>
    <div className="commerce-layout">
      <div className="commerce-stack">
        <CaseHistory orderCase={orderCase} />
      </div>
      <div className="commerce-stack">
        {orderCase.returnDisposition && (
          <section className="commerce-panel">
            <h2>Inspection result</h2>
            <p>{orderCase.returnDisposition === "RESTOCK" ? "The received items were restored to available stock."
              : "The parcel is held for review."}</p>
          </section>
        )}
        {orderCase.status === "REFUND_APPROVED" && orderCase.refund?.state !== "CONFIRMED" && !orderCase.canProcessRefund && (
          <section className="commerce-panel">
            <h2>Refund needs reconciliation</h2>
            <p>Provider processing is unavailable for this case. Review the original payment in the payment workspace.</p>
          </section>
        )}
        <ReviewOrderCase orderCase={orderCase} market={marketConfiguration(orderCase.order.marketId)} />
      </div>
    </div>
  </>);
}
