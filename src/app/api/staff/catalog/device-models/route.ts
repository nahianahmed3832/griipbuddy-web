import { searchApprovedDevices } from "@/lib/staff/device-fitment";
import { catalogSearchParams } from "@/lib/staff/taxonomy-assignment-read";
import { taxonomyOwnerResponse } from "@/lib/staff/taxonomy-owner-response";

export function GET(request: Request) {
  return taxonomyOwnerResponse(actorId => searchApprovedDevices(actorId, catalogSearchParams(request)));
}
