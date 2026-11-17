"use server";

import { revalidatePath } from "next/cache";
import { getStaff } from "@/lib/staff/access";
import { adjustStock, advanceFulfillment, cancelOrder, collectCash, OperationError, recordBangladeshTracking, reviewManualPayment, updatePrice } from "@/lib/staff/operations";
import { parseMinorUnits } from "@/lib/staff/catalog-input";
import { reportFailure } from "@/lib/db/observability";
import { refundPayPalOrder } from "@/lib/commerce/paypal-refund";
import { uuid } from "@/lib/commerce/checkout-types";

type ActionState = { error?: string; success?: string };

async function perform(task: (actorId: string) => Promise<void>, path: string, success: string): Promise<ActionState> {
  try {
    const staff = await getStaff();
    if (!staff) return { error: "Sign in as authorized staff to continue." };
    await task(staff.id);
    revalidatePath(path);
    if (path === "/staff/catalog") revalidatePath("/", "layout");
    return { success };
  } catch (error) {
    if (!(error instanceof OperationError)) reportFailure("staff.order-or-stock-update", undefined, error);
    return { error: error instanceof OperationError ? error.message : "The update could not be saved. Try again." };
  }
}

export async function advanceOrder(orderId: string, _state: ActionState, form: FormData) {
  return perform((actorId) => advanceFulfillment(actorId, orderId, {
    next: form.get("next"), carrier: form.get("carrier") ?? undefined, trackingReference: form.get("trackingReference") ?? undefined,
    simulate: form.get("simulate") === "yes",
  }), `/staff/orders/${orderId}`, "Fulfillment updated.");
}

export async function recordBangladeshTrackingAction(orderId: string, _state: ActionState, form: FormData) {
  const result = await perform((actorId) => recordBangladeshTracking(actorId, orderId, {
    status: form.get("status"), evidence: form.get("evidence") ?? undefined,
  }), `/staff/orders/${orderId}`, "Courier status recorded.");
  if (result.success) {
    revalidatePath(`/orders/${orderId}`);
    revalidatePath("/orders");
    revalidatePath("/staff");
  }
  return result;
}

export async function cancelOrderAction(orderId: string, _state: ActionState, form: FormData) {
  if (form.get("confirm") !== "yes") return { error: "Confirm cancellation first." };
  return perform((actorId) => cancelOrder(actorId, orderId), `/staff/orders/${orderId}`, "Order cancelled and stock restored.");
}

export async function collectCashAction(orderId: string, _state: ActionState, form: FormData) {
  if (form.get("confirm") !== "yes") return { error: "Confirm the cash was received first." };
  return perform((actorId) => collectCash(actorId, orderId), `/staff/orders/${orderId}`, "Cash collection recorded.");
}

export async function reviewManualPaymentAction(orderId: string, approve: boolean, _state: ActionState, form: FormData) {
  if (form.get("confirm") !== "yes") return { error: "Confirm the payment decision first." };
  const result = await perform(actorId => reviewManualPayment(actorId, orderId, approve
    ? { approve, amountMinor: parseMinorUnits(form.get("amount")), transaction: form.get("transaction") }
    : { approve, note: form.get("reason") }), `/staff/orders/${orderId}`,
  approve ? "Payment verified. This order can now be packed." : "Payment declined. The order was cancelled and stock was restored.");
  if (result.success) {
    revalidatePath(`/orders/${orderId}`);
    revalidatePath("/orders");
    revalidatePath("/staff");
    revalidatePath("/seller/orders");
  }
  return result;
}

export async function refundPayPalAction(orderId: string, _state: ActionState, form: FormData): Promise<ActionState> {
  if (!uuid.safeParse(orderId).success || form.get("confirm") !== "yes") return { error: "Confirm the PayPal sandbox refund first." };
  try {
    const staff = await getStaff();
    if (!staff) return { error: "Sign in as authorized staff to continue." };
    const result = await refundPayPalOrder(staff.id, orderId);
    revalidatePath(`/staff/orders/${orderId}`);
    revalidatePath(`/orders/${orderId}`);
    revalidatePath("/staff");
    return { success: result === "refunded" ? "PayPal sandbox refund confirmed and stock restored." : "PayPal hasn’t confirmed the refund. Check its status here." };
  } catch (error) {
    if (!(error instanceof OperationError)) reportFailure("paypal.refund", undefined, error);
    revalidatePath(`/staff/orders/${orderId}`);
    return { error: error instanceof OperationError ? error.message : "Refund status could not be confirmed. Check its status before trying again." };
  }
}

function integer(value: FormDataEntryValue | null): number {
  return typeof value === "string" && /^-?\d{1,10}$/.test(value) ? Number(value) : NaN;
}

export async function updateStockAction(variantId: string, _state: ActionState, form: FormData) {
  return perform((actorId) => adjustStock(actorId, {
    variantId, delta: integer(form.get("delta")), reason: form.get("reason"),
  }), "/staff/catalog", "Stock adjusted.");
}

export async function updatePriceAction(variantId: string, marketId: string, expectedMinor: number, _state: ActionState, form: FormData) {
  return perform((actorId) => updatePrice(actorId, {
    variantId, marketId, expectedMinor, amountMinor: parseMinorUnits(form.get("price")),
  }), "/staff/catalog", "Price updated.");
}
