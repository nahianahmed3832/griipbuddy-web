import { readCarrierTrackingRelay } from "@/lib/commerce/carrier-tracking-relay";
import { recordCarrierParcelObservation } from "@/lib/commerce/order-parcel-tracking";
import { privateHeaders } from "@/lib/db/http";
import { reportFailure } from "@/lib/db/observability";
import { CatalogWriteError } from "@/lib/staff/operation-error";

const headers = { ...privateHeaders, "X-Robots-Tag": "noindex, nofollow" };

export async function POST(request: Request) {
  try {
    const result = await readCarrierTrackingRelay(request);
    if ("errorStatus" in result) return new Response(null, { status: result.errorStatus, headers });
    const receipt = await recordCarrierParcelObservation(result.observation);
    return Response.json(receipt, { headers });
  } catch (error) {
    if (error instanceof CatalogWriteError) return new Response(null, { status: error.status, headers });
    reportFailure("order_tracking.relay", undefined, error);
    return new Response(null, { status: 503, headers });
  }
}
