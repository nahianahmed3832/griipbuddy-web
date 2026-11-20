import { privateHeaders } from "@/lib/db/http";
import { reportFailure } from "@/lib/db/observability";
import { currentMarket } from "@/lib/market-server";
import { SellerFinanceError, sellerFinanceTestEnabled, staffSellerFinance } from "@/lib/marketplace/seller-finance";
import { financeExportQuery, financeScope, financeStatementCsv } from "@/lib/marketplace/seller-finance-view";
import { getStaffFromHeaders } from "@/lib/staff/access";

export async function GET(request: Request) {
  const reject = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (!sellerFinanceTestEnabled()) return reject("Statement unavailable.", 404);
  try {
    const staff = await getStaffFromHeaders(request.headers);
    if (!staff) return reject("Sign in to continue.", 401);
    if (staff.role !== "OWNER") return reject("Statement unavailable.", 404);
    const url = new URL(request.url);
    const { id } = await currentMarket();
    const scope = financeScope(financeExportQuery(url), id);
    if (!scope?.range) return reject("Choose a valid market and statement period.", 400);
    const { marketId, shopId, range } = scope;
    const statement = await staffSellerFinance(staff.id, marketId, shopId, range);
    return new Response(financeStatementCsv(statement), { headers: {
      ...privateHeaders, "Content-Type": "text/csv; charset=utf-8", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="test-finance-${marketId}-${range.from}-to-${range.to}.csv"`,
    } });
  } catch (error) {
    if (error instanceof SellerFinanceError) return reject(error.message, error.status);
    reportFailure("staff.seller-finance.export", undefined, error);
    return reject("Statement export is temporarily unavailable.", 503);
  }
}
