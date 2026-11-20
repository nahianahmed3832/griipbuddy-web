"use server";

import { revalidatePath } from "next/cache";
import { receiveBangladeshRefusedParcel } from "@/lib/commerce/bangladesh-returns";
import { reportFailure } from "@/lib/db/observability";
import { getStaff } from "@/lib/staff/access";
import { OperationError } from "@/lib/staff/operations";

type ActionState = { error?: string; success?: string };

export async function receiveBangladeshRefusedParcelAction(orderId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  if (form.get("confirm") !== "yes") return { error: "Confirm that you received and inspected the parcel." };
  try {
    const staff = await getStaff();
    if (!staff) return { error: "Sign in as authorized staff to continue." };
    const result = await receiveBangladeshRefusedParcel(staff.id, orderId, {
      disposition: form.get("disposition"), note: form.get("note"),
    });
    revalidatePath(`/staff/orders/${orderId}`);
    revalidatePath("/staff");
    revalidatePath("/staff/catalog/inventory");
    revalidatePath(`/orders/${orderId}`);
    if (result.restockedUnits) revalidatePath("/", "layout");
    return { success: result.disposition === "RESTOCK"
      ? `Receipt recorded. Stock restored: ${result.restockedUnits} unit(s).`
      : "Receipt recorded. The parcel is held for review and stock was not changed." };
  } catch (error) {
    if (!(error instanceof OperationError)) reportFailure("bangladesh.refused-parcel-receive", undefined, error);
    return { error: error instanceof OperationError ? error.message : "The receipt could not be saved. Try again." };
  }
}
