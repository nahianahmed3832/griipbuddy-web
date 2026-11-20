"use server";

import { revalidatePath } from "next/cache";
import type { MarketId } from "@/config/markets";
import { getStaff } from "@/lib/staff/access";
import { getShopper } from "@/lib/marketplace/auth";
import { saveCatalogCopySuggestion, type CopyActor } from "@/lib/intelligence/catalog-copy-suggestions";
import { reportFailure } from "@/lib/db/observability";

type Status = { error?: string; success?: string };

export async function generateCatalogCopy(kind: CopyActor["kind"], market: MarketId, shopId: string | null, _: Status, form: FormData): Promise<Status> {
  const principal = kind === "staff" ? await getStaff() : await getShopper();
  if (!principal) return { error: "Sign in again to generate a suggestion." };
  const actor: CopyActor | null = kind === "staff" ? { kind, id: principal.id } : shopId ? { kind, id: principal.id, shopId } : null;
  if (!actor) return { error: "Choose an authorized shop." };
  try {
    const outcome = await saveCatalogCopySuggestion(actor, market, {
      operationId: form.get("operationId"), productId: form.get("productId"), purpose: form.get("purpose"),
    });
    if (outcome.kind === "disabled") return { error: "The local catalog copy adapter is disabled." };
    if (outcome.kind === "invalid") return { error: "Choose a valid product and copy field." };
    if (outcome.kind === "missing") return { error: "This product is unavailable in your authorized market." };
    if (outcome.kind === "conflict") return { error: "This request was already used. Refresh to start a new suggestion." };
    revalidatePath(kind === "staff" ? "/staff/intelligence/catalog-copy" : "/seller/catalog-copy");
    return outcome.record.state === "SAVED"
      ? { success: "Suggestion saved. Review it in the history before using it in catalog authoring." }
      : { error: "The test adapter returned no valid copy. No content changed. Submit again for a new attempt." };
  } catch (error) {
    reportFailure("catalog-copy.fixture", undefined, error);
    return { error: "The copy service is temporarily unavailable." };
  }
}
