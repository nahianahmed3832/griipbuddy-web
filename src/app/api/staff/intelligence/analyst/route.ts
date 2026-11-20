import { NextResponse } from "next/server";
import { z } from "zod";
import { isMarketId, type MarketId } from "@/config/markets";
import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { answerProductIntelligence } from "@/lib/intelligence/analyst";
import { productIntelligence } from "@/lib/intelligence/dataset";
import { loadForecastBoard } from "@/lib/intelligence/forecast-board";
import { loadOpportunityAssessments } from "@/lib/intelligence/load-report";
import { intelligenceUrl } from "@/lib/intelligence/navigation";
import { getStaff } from "@/lib/staff/access";
import { staffMarketIds } from "@/lib/staff/market-access";

const input = z.strictObject({ marketId: z.custom<MarketId>(isMarketId), test: z.boolean(), from: z.iso.date(), to: z.iso.date(),
  question: z.string().trim().min(3).max(240), productId: z.string().min(1).max(120).optional(), variantId: z.string().min(1).max(120).optional(),
});

export async function POST(request: Request) {
  const error = (message: string, status: number) => NextResponse.json({ error: message }, { status, headers: privateHeaders });
  if (!sameOrigin(request)) return error("Request unavailable.", 403);
  const staff = await getStaff();
  if (!staff) return error("Staff sign-in is required.", 401);
  const parsed = input.safeParse(await readJson(request, 4096));
  if (!parsed.success) return error("Choose a market, date range, and short question.", 400);
  const { question, ...filters } = parsed.data;
  try {
    const allowed = await staffMarketIds(staff.id, "reporting");
    if (!allowed.includes(filters.marketId)) return error("This market report is unavailable.", 404);
    if (!await consumeQuota("staff.intelligence.analyst", staff.id, 18, 60)) return error("Wait a moment before asking another question.", 429);
    const report = await productIntelligence(filters);
    if (report.kind !== "report") return error("Narrow the report period or select one product.", 422);
    const stockQuestion = /replenish|restock|inventory|stock ?risk|purchase proposal|order quantity/i.test(question);
    const [assessments, stock] = await Promise.all([loadOpportunityAssessments(report, filters), stockQuestion ? loadForecastBoard(report, {
      productId: filters.productId, variantId: filters.variantId, horizonDays: 7, authorizedMarkets: allowed,
    }).catch(() => null) : null]);
    const inventory = stock?.entries.flatMap(({ row, inventory: recommendation }) => recommendation ? [{ ...recommendation,
      name: row.variantName ? `${row.name} · ${row.variantName}` : row.name, productId: row.productId,
      href: intelligenceUrl({ market: report.marketId, scope: report.test ? "test" : "live", view: "forecast", from: report.window.from,
        to: report.window.to, product: row.productId, variant: row.variantId ?? undefined, section: "stock-risk" }),
    }] : []);
    const answer = await answerProductIntelligence({ report, assessments, question, inventory });
    return NextResponse.json({ answer }, { headers: privateHeaders });
  } catch (cause) {
    reportFailure("intelligence.analyst", undefined, cause);
    return error("The market evidence is temporarily unavailable.", 503);
  }
}
