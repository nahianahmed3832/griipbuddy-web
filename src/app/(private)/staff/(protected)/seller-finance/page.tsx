import { notFound } from "next/navigation";
import { FinanceScopeForm, FinanceStatementView, StaffFinanceControls } from "@/components/marketplace/seller-finance";
import styles from "@/components/marketplace/seller-finance.module.css";
import { reportFailure } from "@/lib/db/observability";
import { marketConfiguration } from "@/lib/market-config";
import { currentMarket } from "@/lib/market-server";
import { SellerFinanceError, sellerFinanceTestEnabled, staffSellerFinance } from "@/lib/marketplace/seller-finance";
import { financeScope, type FinanceQuery } from "@/lib/marketplace/seller-finance-view";
import { requireStaff } from "@/lib/staff/access";
import { staffMarketIds } from "@/lib/staff/market-access";

export const metadata = { title: "Seller finance administration" };

export default async function StaffSellerFinancePage({ searchParams }: { searchParams: Promise<FinanceQuery> }) {
  if (!sellerFinanceTestEnabled()) notFound();
  const [staff, query, current] = await Promise.all([requireStaff(), searchParams, currentMarket()]);
  if (staff.role !== "OWNER") notFound();
  const scope = financeScope(query, current.id);
  if (!scope) notFound();
  const { marketId, shopId, range } = scope;
  const allowed = await staffMarketIds(staff.id, "commercial");
  if (!allowed.includes(marketId)) notFound();
  const market = marketConfiguration(marketId);

  const result = range ? await staffSellerFinance(staff.id, marketId, shopId, range).catch((error: unknown) => {
    if (error instanceof SellerFinanceError) return error;
    reportFailure("staff.seller-finance.statement", undefined, error);
    return new Error("The finance workspace is temporarily unavailable. Reload to try again.");
  }) : null;
  if (result instanceof SellerFinanceError && (result.status === 404 || result.status === 403)) notFound();

  return <div className={styles.workspace}>
    <header className="commerce-intro">
      <h1 className="display-type">Seller finance administration</h1>
      <p>{market.name} · {market.currency}</p>
    </header>
    <p className={styles.warning}>Isolated test finance. Processing records an explicitly simulated outcome.</p>
    <FinanceScopeForm path="/staff/seller-finance" market={market} markets={allowed.map(marketConfiguration)} range={range}
      shops={result && !(result instanceof Error) ? result.shops : undefined} selectedShop={shopId}
      exportPath={result && !(result instanceof Error) ? "/api/staff/seller-finance.csv" : undefined} />
    {result instanceof Error ? <p role="alert" className={styles.error}>{result.message}</p> : result && <>
      <FinanceStatementView statement={result} market={market} staff />
      <StaffFinanceControls statement={result} market={market} />
    </>}
  </div>;
}
