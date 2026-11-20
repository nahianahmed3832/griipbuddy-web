import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { readJson, sameOrigin } from "@/lib/db/http";
import { CatalogWriteError, catalogWriteInput } from "@/lib/staff/operation-error";
import { catalogSearchParams } from "@/lib/staff/taxonomy-assignment-read";
import { categoryAttributeWorkspace, previewCategoryAttributeImpact } from "@/lib/staff/taxonomy-attribute-read";
import { taxonomyOwnerResponse } from "@/lib/staff/taxonomy-owner-response";

export function GET(request: Request) {
  return taxonomyOwnerResponse(request, actorId => getDb().$transaction(
    tx => categoryAttributeWorkspace(actorId, catalogSearchParams(request), tx),
    { isolationLevel: "RepeatableRead" },
  ));
}

const previewQuery = z.strictObject({ page: z.string().regex(/^[1-9][0-9]{0,4}$/).transform(Number).default(1) });

export function POST(request: Request) {
  return taxonomyOwnerResponse(request, async actorId => {
    if (!sameOrigin(request)) throw new CatalogWriteError("forbidden", "Open this action from the catalog workspace.");
    const { page } = catalogWriteInput(previewQuery, catalogSearchParams(request));
    return previewCategoryAttributeImpact(actorId, await readJson(request), page);
  });
}
