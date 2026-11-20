import { catalogSearchParams, categoryAssignmentProducts } from "@/lib/staff/taxonomy-assignment-read";
import { taxonomyOwnerResponse } from "@/lib/staff/taxonomy-owner-response";
import { getDb } from "@/lib/db/client";

export function GET(request: Request) {
  return taxonomyOwnerResponse(request, actorId => getDb().$transaction(
    tx => categoryAssignmentProducts(actorId, catalogSearchParams(request), tx),
    { isolationLevel: "RepeatableRead" },
  ));
}
