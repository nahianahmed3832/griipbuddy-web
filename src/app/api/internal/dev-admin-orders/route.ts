import { executeDevAdminReturn, OrderCaseError } from "@/lib/marketplace/cases";
import { saveHybridOrderDetails } from "@/lib/staff/dev-admin-order-details";
import { getDb } from "@/lib/db/client";
import { privateHeaders } from "@/lib/db/http";
import { canReadDevAdminOrders, readDevAdminOrderQuery, readDevAdminOrders } from "@/lib/staff/dev-admin-orders";
import { readDevAdminOrderProof, validDevAdminDetailProof } from "@/lib/staff/dev-admin-order-proof";
import { recordHybridReturnCost } from "@/lib/staff/hybrid-return-cost";
import { receiveBangladeshRefusedParcel } from "@/lib/commerce/bangladesh-returns";
import { advanceFulfillment, cancelOrder, collectCash, OperationError, recordBangladeshTracking, reviewManualPayment } from "@/lib/staff/operations";

const headers = { ...privateHeaders, "X-Robots-Tag": "noindex, nofollow" };
const notFound = () => new Response(null, { status: 404, headers });

export async function GET(request: Request) {
  if (!canReadDevAdminOrders(request.headers.get("authorization"))) return notFound();
  const params = new URL(request.url).searchParams;
  const query = readDevAdminOrderQuery(params);
  if (!query) return Response.json({ error: "Invalid order request." }, { status: 400, headers });
  if (query.kind === "detail" && query.operations &&
      !validDevAdminDetailProof(params.toString(), request.headers.get("x-griip-hybrid-proof"))) return notFound();
  try {
    const data = await readDevAdminOrders(getDb(), query);
    return data ? Response.json(data, { headers }) : notFound();
  } catch {
    return Response.json({ error: "Checkout orders are temporarily unavailable." }, { status: 503, headers });
  }
}

export async function POST(request: Request) {
  if (!canReadDevAdminOrders(request.headers.get("authorization")) || new URL(request.url).search ||
      !request.headers.get("content-type")?.startsWith("application/json")) return notFound();
  const limit = 16_000;
  if (Number(request.headers.get("content-length")) > limit) return notFound();
  const reader = request.body?.getReader();
  if (!reader) return notFound();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); return notFound(); }
      chunks.push(value);
    }
  } catch {
    return notFound();
  }
  const proof = readDevAdminOrderProof(Buffer.concat(chunks).toString("utf8"), request.headers.get("x-griip-hybrid-proof"));
  if (!proof) return notFound();
  const { id, operator, command } = proof;
  try {
    switch (command.action) {
      case "edit-contact":
      case "add-note": await saveHybridOrderDetails(operator, id, command); break;
      case "open-return":
      case "review-return":
      case "receive-return":
      case "confirm-return-refund": await executeDevAdminReturn(operator, id, command); break;
      case "record-return-cost": await recordHybridReturnCost(operator, id, command); break;
      case "advance": await advanceFulfillment(operator, id, command); break;
      case "track": await recordBangladeshTracking(operator, id, command); break;
      case "receive": await receiveBangladeshRefusedParcel(operator, id, command); break;
      case "collect": await collectCash(operator, id); break;
      case "cancel": await cancelOrder(operator, id); break;
      case "approve-wallet": await reviewManualPayment(operator, id, { ...command, approve: true }); break;
      case "decline-wallet": await reviewManualPayment(operator, id, { ...command, approve: false }); break;
    }
    return Response.json({ saved: true }, { headers });
  } catch (error) {
    if (error instanceof OperationError || error instanceof OrderCaseError) return error.status === 404 ? notFound()
      : Response.json({ error: error.message }, { status: error.status, headers });
    return Response.json({ error: "Could not confirm the fulfillment change. Refresh the order before retrying." }, { status: 503, headers });
  }
}
