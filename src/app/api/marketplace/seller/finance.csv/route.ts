import { privateHeaders } from "@/lib/db/http";
import { reportFailure } from "@/lib/db/observability";
import { currentMarket } from "@/lib/market-server";
import { shopperActor } from "@/lib/marketplace/auth";
import { resolveSellerAccess } from "@/lib/marketplace/seller-access";
import { SellerFinanceError, sellerFinanceStatement, sellerFinanceTestEnabled } from "@/lib/marketplace/seller-finance";
import { financeExportQuery, financeScope, financeStatementCsv } from "@/lib/marketplace/seller-finance-view";
import { marketplaceMode } from "@/lib/release-config";

export async function GET(request: Request) {
  const reject = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!marketplaceMode() || !sellerFinanceTestEnabled()) return reject("Statement unavailable.", 404);
  try {
    const shopper = await shopperActor(request.headers);
    if (!shopper) return reject("Sign in to continue.", 401);
    const selected = await currentMarket();
    const url = new URL(request.url);
    const scope = financeScope(financeExportQuery(url), selected.id, url.origin);
    if (!scope?.range) return reject("Choose a valid market and statement period.", 400);
    const { marketId, shopId, range } = scope;
    const access = await resolveSellerAccess(shopper.id, marketId, "FINANCE_VIEW", shopId);
    if (!access) return reject("Statement unavailable.", 404);
    const statement = await sellerFinanceStatement(shopper.id, access.shop.id, marketId, range);
    return new Response(financeStatementCsv(statement), { headers: {
      ...privateHeaders, "Content-Type": "text/csv; charset=utf-8", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="test-finance-${marketId}-${range.from}-to-${range.to}.csv"`,
    } });
  } catch (error) {
    if (error instanceof SellerFinanceError) return reject(error.message, error.status);
    reportFailure("seller.finance.export", undefined, error);
    return reject("Statement export is temporarily unavailable.", 503);
  }
}
