import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { SellerPageHeader, SellerStatus } from "@/components/marketplace/seller-ui";
import { caseProgressLabel } from "@/components/marketplace/case-panels";
import { orderDate } from "@/lib/commerce/labels";
import { currentMarket } from "@/lib/market-server";
import { caseKindLabels } from "@/lib/marketplace/case-policy";
import { sellerCaseDetail } from "@/lib/marketplace/seller-cases";
import { sellerWorkspace } from "@/lib/marketplace/seller-workspace";

export const metadata = { title: "Shop order request", robots: { index: false, follow: false } };

export default async function SellerCase({ params, searchParams }: {
  params: Promise<{ caseId: string }>;
  searchParams: Promise<{ market?: string | string[] }>;
}) {
  const [{ shop }, market, { caseId }, query] = await Promise.all([sellerWorkspace(), currentMarket(), params, searchParams]);
  if (!shop || !z.uuid().safeParse(caseId).success || query.market !== undefined && query.market !== market.id) notFound();
  const orderCase = await sellerCaseDetail(shop.id, market.id, caseId);
  if (!orderCase) notFound();
  return <>
    <SellerPageHeader title={caseKindLabels[orderCase.kind]} description={`Order ${orderCase.order.reference} · ${market.name} · ${market.currency}`}
      actions={<>
        <Link href={`/seller/cases?market=${market.id}`} className="seller-button" prefetch={false}>Back to requests</Link>
        <Link href={`/seller/orders/${orderCase.order.id}?market=${market.id}`} className="seller-button" prefetch={false}>View order</Link>
      </>}/>
    <div className="seller-grid">
      <section className="seller-panel" aria-labelledby="case-owned-items">
        <div className="seller-panel-heading"><h2 id="case-owned-items">Your items in this request</h2>
          <SellerStatus>{caseProgressLabel(orderCase.kind, orderCase.status)}</SellerStatus></div>
        <ul className="seller-detail-lines">{orderCase.returnLines.map(({ quantity, orderItem }) => <li key={orderItem.id}>
          <strong>{quantity} × {orderItem.productName}</strong>
          <p className="seller-muted">{orderItem.variantName} · {orderItem.sku}</p>
        </li>)}</ul>
      </section>
      <section className="seller-panel" aria-labelledby="case-activity">
        <div className="seller-panel-heading"><h2 id="case-activity">Request activity</h2></div>
        <ol className="seller-detail-lines">{orderCase.events.map(event => <li key={event.revision}>
          <strong>{caseProgressLabel(orderCase.kind, event.status)}</strong>
          <p className="seller-muted">{orderDate(event.createdAt, market.id)}</p>
        </li>)}</ol>
      </section>
    </div>
  </>;
}
