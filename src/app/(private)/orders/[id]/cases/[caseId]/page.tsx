import { notFound } from "next/navigation";
import { z } from "zod";
import { WithdrawOrderCase } from "@/components/marketplace/case-forms";
import { CaseHistory, caseProgressLabel } from "@/components/marketplace/case-panels";
import { Breadcrumbs } from "@/components/store-ui";
import { getShopper } from "@/lib/marketplace/auth";
import { caseKindLabels } from "@/lib/marketplace/case-policy";
import { buyerOrderCase } from "@/lib/marketplace/cases";

export const metadata = { title: "Order case" };

export default async function BuyerCasePage({ params }: { params: Promise<{ id: string; caseId: string }> }) {
  const [{ id, caseId }, shopper] = await Promise.all([params, getShopper()]);
  const uuid = z.uuid();
  if (!shopper || !uuid.safeParse(id).success || !uuid.safeParse(caseId).success) notFound();
  const orderCase = await buyerOrderCase(shopper.id, id, caseId);
  if (!orderCase) notFound();
  const label = caseKindLabels[orderCase.kind];

  return (
    <div className="shell inner-page commerce-page">
      <Breadcrumbs items={[{ label: "Your orders", href: "/orders" }, { label: orderCase.order.reference, href: `/orders/${id}` }, { label }]} />
      <div className="commerce-intro">
        <h1 className="display-type">{label}</h1>
        <p>Order {orderCase.order.reference} · {caseProgressLabel(orderCase.kind, orderCase.status)}</p>
      </div>
      <div className="commerce-stack">
        <CaseHistory orderCase={orderCase} />
        <WithdrawOrderCase orderCase={orderCase} />
      </div>
    </div>
  );
}
