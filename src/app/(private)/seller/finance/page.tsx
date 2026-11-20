import { notFound } from "next/navigation";
import { SignInGate } from "@/components/marketplace/session";
import { FinanceScopeForm, FinanceStatementView, SellerFinanceControls } from "@/components/marketplace/seller-finance";
import { SellerPageHeader } from "@/components/marketplace/seller-ui";
import styles from "@/components/marketplace/seller-finance.module.css";
import { reportFailure } from "@/lib/db/observability";
import { marketConfiguration } from "@/lib/market-config";
import { currentMarket } from "@/lib/market-server";
import { getShopper } from "@/lib/marketplace/auth";
import { resolveSellerAccess } from "@/lib/marketplace/seller-access";
import { sellerFinanceStatement, SellerFinanceError, sellerFinanceTestEnabled } from "@/lib/marketplace/seller-finance";
import { financeScope, type FinanceQuery } from "@/lib/marketplace/seller-finance-view";
import { marketplaceMode } from "@/lib/release-config";

export const metadata = { title: "Seller finance" };

export default async function SellerFinancePage({ searchParams }: { searchParams: Promise<FinanceQuery> }) {
  if (!marketplaceMode() || !sellerFinanceTestEnabled()) notFound();
  const [shopper, query, current] = await Promise.all([getShopper(), searchParams, currentMarket()]);
  if (!shopper) return <div className="shell mp-page">
    <h1 className="mp-page-title">Seller finance</h1><SignInGate>Sign in to view seller finance.</SignInGate>
  </div>;
  const scope = financeScope(query, current.id);
  if (!scope) notFound();
  const { marketId, range } = scope;
  const access = await resolveSellerAccess(shopper.id, marketId, "FINANCE_VIEW", scope.shopId);
  if (!access) notFound();
  const market = marketConfiguration(marketId);
  const result = range ? await sellerFinanceStatement(shopper.id, access.shop.id, marketId, range).catch((error: unknown) => {
    if (error instanceof SellerFinanceError) return error;
    reportFailure("seller.finance.statement", undefined, error);
    return new Error("The statement is temporarily unavailable. Reload to try again.");
  }) : null;
  if (result instanceof SellerFinanceError && (result.status === 404 || result.status === 403)) notFound();

  return <div className={styles.workspace}>
    <SellerPageHeader title="Seller finance" description={`${access.shop.name} · ${market.name} · ${market.currency}`} />
    <p className={styles.warning}>Isolated test finance. All policies, balances and payouts shown here use synthetic records.</p>
    <FinanceScopeForm path="/seller/finance" market={market} range={range} selectedShop={access.shop.id}
      exportPath={result && !(result instanceof Error) ? "/api/marketplace/seller/finance.csv" : undefined} />
    {result instanceof Error ? <p role="alert" className={styles.error}>{result.message}</p> : result && <>
      <FinanceStatementView statement={result} market={market} />
      <SellerFinanceControls statement={result} market={market} shopId={access.shop.id}
        canManageDestinations={access.permissions.includes("PAYOUT_DESTINATION")}
        canRequestPayout={access.permissions.includes("PAYOUT_REQUEST")} />
    </>}
  </div>;
}
