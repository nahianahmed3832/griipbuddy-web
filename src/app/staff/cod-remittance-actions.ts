"use server";

import { revalidatePath } from "next/cache";
import { reportFailure } from "@/lib/db/observability";
import { getStaff } from "@/lib/staff/access";
import { codReconciliationOrder, recordCodRemittance } from "@/lib/staff/cod-remittance";
import { OperationError } from "@/lib/staff/operations";
import { marketConfiguration } from "@/lib/market-config";

type ActionState = { error?: string; success?: string };

function parseMinor(value: FormDataEntryValue | null, minorDigits: number): number {
  if (typeof value !== "string") return NaN;
  const text = value.trim();
  const syntax = minorDigits === 0 ? /^\d{1,10}$/ : new RegExp(`^\\d{1,10}(\\.\\d{1,${minorDigits}})?$`);
  if (!syntax.test(text)) return NaN;
  const [whole, decimal = ""] = text.split(".");
  return Number(whole) * 10 ** minorDigits + Number(decimal.padEnd(minorDigits, "0"));
}

export async function saveCodRemittance(orderId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  if (form.get("confirm") !== "yes") return { error: "Confirm the amounts against the courier remittance first." };
  try {
    const staff = await getStaff();
    if (staff?.role !== "OWNER") return { error: "Sign in as an owner to record remittance." };
    const order = await codReconciliationOrder(staff.id, orderId);
    if (!order) return { error: "COD order unavailable." };
    const { minorDigits } = marketConfiguration(order.marketId);
    const status = await recordCodRemittance(staff.id, orderId, {
      reference: form.get("reference"),
      grossMinor: parseMinor(form.get("gross"), minorDigits),
      deductionsMinor: parseMinor(form.get("deductions"), minorDigits),
      netMinor: parseMinor(form.get("net"), minorDigits),
    });
    revalidatePath("/staff/cod-reconciliation");
    revalidatePath(`/staff/cod-reconciliation/${orderId}`);
    return { success: status === "MATCHED" ? "Courier remittance matched." : "Discrepancy recorded. Review the differences below." };
  } catch (error) {
    if (!(error instanceof OperationError)) reportFailure("staff.cod-remittance", undefined, error);
    return { error: error instanceof OperationError ? error.message : "The remittance could not be recorded. Try again." };
  }
}
