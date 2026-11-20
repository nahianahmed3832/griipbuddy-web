import { revalidatePath } from "next/cache";
import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { getShopper } from "@/lib/marketplace/auth";
import { caseActorRole, caseCommand, caseOpenReceiptInput } from "@/lib/marketplace/case-policy";
import { caseOpenReceipt, executeOrderCase, OrderCaseError } from "@/lib/marketplace/cases";
import { marketplaceMode } from "@/lib/release-config";
import { getStaff } from "@/lib/staff/access";
import { OperationError } from "@/lib/staff/operations";

function reject(message: string, status: number) {
  return Response.json({ message }, { status, headers: privateHeaders });
}

export async function GET(request: Request) {
  if (!marketplaceMode()) return new Response(null, { status: 404, headers: privateHeaders });
  if (request.headers.get("sec-fetch-site") === "cross-site") return reject("Open this action from the storefront.", 403);
  const query = new URL(request.url).searchParams;
  const input = caseOpenReceiptInput.safeParse({ orderId: query.get("orderId"), requestId: query.get("requestId") });
  if (!input.success || query.size !== 2) return reject("Check the request reference and try again.", 400);
  try {
    const shopper = await getShopper();
    if (!shopper) return reject("Sign in to continue.", 401);
    if (!await consumeQuota("marketplace.cases.receipt", shopper.id, 30, 3600)) return reject("Too many actions. Try again shortly.", 429);
    const data = await caseOpenReceipt(input.data.orderId, shopper.id, input.data.requestId);
    return data ? Response.json({ data }, { headers: privateHeaders }) : reject("Submitted request not found.", 404);
  } catch (error) {
    reportFailure("marketplace.cases.receipt", undefined, error);
    return reject("We couldn't check this submission. Try again.", 503);
  }
}

export async function POST(request: Request) {
  if (!marketplaceMode()) return new Response(null, { status: 404, headers: privateHeaders });
  if (!sameOrigin(request)) return reject("Open this action from the storefront.", 403);
  const input = caseCommand.safeParse(await readJson(request, 24_576));
  if (!input.success) return reject("Check the case details and try again.", 400);

  try {
    const command = input.data;
    if (caseActorRole(command) === "owner") {
      const staff = await getStaff();
      if (!staff) return reject("Sign in as staff to continue.", 401);
      if (staff.role !== "OWNER") return reject("You don’t have permission for that action.", 403);
      if (!await consumeQuota("marketplace.cases.owner", staff.id, 90, 300)) return reject("Too many actions. Try again shortly.", 429);
      const data = await executeOrderCase({ id: staff.id, role: "owner" }, command);
      if ((command.action === "receive" && command.disposition === "RESTOCK") ||
          command.action === "approve-cancellation" || command.action === "process-refund" || command.action === "approve-refund" || command.action === "ship-exchange") {
        revalidatePath("/staff");
        revalidatePath("/staff/catalog/inventory");
        revalidatePath("/", "layout");
      }
      return Response.json({ data }, { headers: privateHeaders });
    }

    const shopper = await getShopper();
    if (!shopper) return reject("Sign in to continue.", 401);
    const opening = command.action === "open";
    const quotaKey = opening ? "marketplace.cases.open" : "marketplace.cases.withdraw";
    if (!await consumeQuota(quotaKey, shopper.id, opening ? 8 : 30, 3600)) {
      return reject("Too many actions. Try again shortly.", 429);
    }
    const data = await executeOrderCase({ id: shopper.id, role: "shopper" }, command);
    return Response.json({ data }, { status: opening ? 201 : 200, headers: privateHeaders });
  } catch (error) {
    if (error instanceof OrderCaseError) return reject(error.message, error.status);
    if (error instanceof OperationError) return reject(error.message, 403);
    if (typeof error === "object" && error && "code" in error && error.code === "P2002") {
      return reject("This case changed while you were working. Refresh the page and try again.", 409);
    }
    reportFailure("marketplace.cases.write", undefined, error);
    return reject("We couldn't save this change. Try again.", 503);
  }
}
