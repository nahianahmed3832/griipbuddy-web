"use server";

import { revalidatePath } from "next/cache";
import { reportFailure } from "@/lib/db/observability";
import { getStaff } from "@/lib/staff/access";
import { recordCodRemittance } from "@/lib/staff/cod-remittance";
import { OperationError } from "@/lib/staff/operations";

type ActionState = { error?: string; success?: string };

function parseBdt(value: FormDataEntryValue | null): number {
  if (typeof value !== "string") return NaN;
  const text = value.trim();
  if (!/^\d{1,8}(\.\d{1,2})?$/.test(text)) return NaN;
  const [whole, decimal = ""] = text.split(".");
  return Number(whole) * 100 + Number(decimal.padEnd(2, "0"));
}

export async function saveCodRemittance(orderId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  if (form.get("confirm") !== "yes") return { error: "Confirm the amounts against the courier remittance first." };
  try {
    const staff = await getStaff();
    if (staff?.role !== "OWNER") return { error: "Sign in as an owner to record remittance." };
    const status = await recordCodRemittance(staff.id, orderId, {
      reference: form.get("reference"),
      grossMinor: parseBdt(form.get("gross")),
      deductionsMinor: parseBdt(form.get("deductions")),
      netMinor: parseBdt(form.get("net")),
    });
    revalidatePath("/staff/cod-reconciliation");
    revalidatePath(`/staff/cod-reconciliation/${orderId}`);
    return { success: status === "MATCHED" ? "Courier remittance matched." : "Discrepancy recorded. Review the differences below." };
  } catch (error) {
    if (!(error instanceof OperationError)) reportFailure("staff.cod-remittance", undefined, error);
    return { error: error instanceof OperationError ? error.message : "The remittance could not be recorded. Try again." };
  }
}
