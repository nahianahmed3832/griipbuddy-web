import { privateHeaders } from "@/lib/db/http";
import { reportFailure } from "@/lib/db/observability";
import { currentMarket } from "@/lib/market-server";
import { getStaffFromHeaders } from "@/lib/staff/access";
import { loadOperationsReport, OperationsReportError, reportQuery } from "@/lib/staff/operations-report";
import { operationsCsv } from "@/lib/staff/operations-report-table";

export async function GET(request: Request) {
  const reject = (message: string, status: number) => Response.json({ message }, { status, headers: privateHeaders });
  if (request.headers.get("sec-fetch-site") === "cross-site") return reject("Open exports from the staff workspace.", 403);
  try {
    const actor = await getStaffFromHeaders(request.headers);
    if (!actor) return reject("Sign in to continue.", 401);
    const query = new URL(request.url).searchParams;
    const values = Object.fromEntries(query);
    if ([...query.keys()].length !== Object.keys(values).length) return reject("Choose a single value for each filter.", 400);
    const { table, ...filters } = values;
    if (table !== undefined && table !== "1" && table !== "2") return reject("Choose a valid report table.", 400);
    const selected = await currentMarket();
    const scope = reportQuery(filters, selected.id, process.env.BETTER_AUTH_URL ?? "");
    const report = await loadOperationsReport(actor.id, scope);
    const csv = operationsCsv(report, Number(table) || 1);
    if (csv === null) return reject("The report table is unavailable.", 404);
    return new Response(csv, { headers: { ...privateHeaders,
      "Content-Type": "text/csv; charset=utf-8", "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="operations-${scope.marketId}-${scope.view}-${scope.range.to}.csv"`,
    } });
  } catch (error) {
    if (error instanceof OperationsReportError) return reject(error.message, error.status);
    reportFailure("staff.operations-report.export", undefined, error);
    return reject("The report export is temporarily unavailable.", 503);
  }
}
