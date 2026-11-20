"use server";

import { revalidatePath } from "next/cache";
import { getStaff } from "@/lib/staff/access";
import { pauseMarketCheckout, saveDeliveryZone, saveMarketPolicy } from "@/lib/staff/market-settings";
import type { MarketId } from "@/config/markets";
import { OperationError } from "@/lib/staff/operations";
import { parseMinorUnits } from "@/lib/staff/catalog-input";
import { reportFailure } from "@/lib/db/observability";

async function save(task: (id: string) => Promise<void>, message: string) {
  const actor = await getStaff();
  if (actor?.role !== "OWNER") return { error: "Owner access is required." };
  try {
    await task(actor.id);
    revalidatePath("/", "layout");
    return { success: message };
  } catch (error) {
    if (error instanceof OperationError) return { error: error.message };
    reportFailure("staff.market-settings", undefined, error);
    return { error: "Settings could not be saved. Try again." };
  }
}

export async function saveMarketAction(marketId: string, revision: number | null, _state: unknown, form: FormData) {
  const tax = form.get("tax");
  return save((actorId) => saveMarketPolicy(actorId, {
    marketId, revision, enabled: form.has("enabled"), codEnabled: form.has("cod"),
    taxLabel: form.get("taxLabel"), taxBasisPoints: tax === "" ? null : parseMinorUnits(tax),
  }), "Market settings saved.");
}

export async function pauseMarketAction(marketId: MarketId) {
  return save((actorId) => pauseMarketCheckout(actorId, marketId), "New orders paused.");
}

export async function saveDeliveryAction(
  marketId: string, existing: { district: string; method: string; revision: number } | null, _state: unknown, form: FormData,
) {
  const charge = form.get("charge");
  return save((actorId) => saveDeliveryZone(actorId, {
    marketId, revision: existing?.revision ?? null,
    district: existing?.district ?? form.get("district"), method: existing?.method ?? form.get("method"),
    districtLabel: form.get("districtLabel"), label: form.get("label"), guidance: form.get("guidance"),
    chargeMinor: charge === "" ? null : parseMinorUnits(charge), enabled: form.has("enabled"), codEligible: form.has("cod"),
  }), "Delivery option saved.");
}
