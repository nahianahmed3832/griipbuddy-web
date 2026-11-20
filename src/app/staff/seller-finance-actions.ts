"use server";

import { revalidatePath } from "next/cache";
import type { MarketId } from "@/config/markets";
import { reportFailure } from "@/lib/db/observability";
import { marketConfiguration } from "@/lib/market-config";
import { getShopper } from "@/lib/marketplace/auth";
import {
  SellerFinanceError, sellerFinanceAction, staffSellerFinanceAction,
} from "@/lib/marketplace/seller-finance";
import { getStaff } from "@/lib/staff/access";

type State = { error?: string; success?: string };
type SellerKind = "destination-submit" | "destination-revoke" | "payout-request";
type StaffKind = "policy-create" | "reconcile-order" | "online-release" | "destination-review"
  | "payout-review" | "payout-process" | "payout-reconcile";

function whole(value: FormDataEntryValue | null) {
  return typeof value === "string" && /^\d{1,10}$/u.test(value) ? Number(value) : NaN;
}

function minor(value: FormDataEntryValue | null, marketId: MarketId) {
  if (typeof value !== "string" || !/^\d{1,10}(\.\d{1,4})?$/u.test(value)) return NaN;
  const { minorDigits } = marketConfiguration(marketId);
  const [units, decimals = ""] = value.split(".");
  if (decimals.length > minorDigits) return NaN;
  return Number(units) * 10 ** minorDigits + Number(decimals.padEnd(minorDigits, "0"));
}

function dateTime(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return undefined;
  const parsed = new Date(value + ":00.000Z");
  return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 16) !== value ? undefined : parsed.toISOString();
}

function financeFailure(scope: string, error: unknown): State {
  if (error instanceof SellerFinanceError) return { error: error.message };
  reportFailure(scope, undefined, error);
  return { error: "The finance action could not be saved. Try again." };
}

export async function saveSellerFinance(shopId: string, marketId: MarketId, kind: SellerKind, _state: State, form: FormData): Promise<State> {
  try {
    const shopper = await getShopper();
    if (!shopper) return { error: "Sign in to continue." };
    const operationId = form.get("operationId");
    const destinationId = form.get("destinationId");
    const amountMinor = kind === "payout-request" ? minor(form.get("amount"), marketId) : 0;
    const input = kind === "destination-submit" ? { kind, operationId, label: form.get("label"), testReference: form.get("testReference") }
      : kind === "destination-revoke" ? { kind, destinationId }
        : { kind, operationId, destinationId, amountMinor };
    if (kind === "payout-request" && !Number.isSafeInteger(amountMinor)) {
      return { error: "Enter an amount with the market’s currency precision." };
    }
    await sellerFinanceAction(shopper.id, shopId, marketId, input);
    revalidatePath("/seller/finance");
    return { success: kind === "payout-request" ? "Test payout request submitted." : "Test payout destination updated." };
  } catch (error) {
    return financeFailure("seller.finance", error);
  }
}

export async function saveStaffSellerFinance(marketId: MarketId, kind: StaffKind, _state: State, form: FormData): Promise<State> {
  try {
    const staff = await getStaff();
    if (!staff || staff.role !== "OWNER") return { error: "Sign in as an owner to manage seller finance." };
    const operationId = form.get("operationId");
    const reason = form.get("reason");
    const orderId = form.get("orderId");
    const payoutId = form.get("payoutId");
    const effectiveAt = dateTime(form.get("effectiveAt"));
    if (kind === "policy-create" && form.get("effectiveAt") && !effectiveAt) {
      return { error: "Choose a valid UTC effective date and time." };
    }
    const input = kind === "policy-create" ? {
      kind, operationId, commissionBps: whole(form.get("commissionBps")), processingFeeBps: whole(form.get("processingFeeBps")),
      holdDays: whole(form.get("holdDays")), ...(effectiveAt && { effectiveAt }),
    } : kind === "reconcile-order" ? { kind, orderId }
      : kind === "online-release" ? { kind, operationId, orderId, reason, testReference: form.get("testReference") }
        : kind === "destination-review" ? { kind, destinationId: form.get("destinationId"), decision: form.get("decision"), reason }
          : kind === "payout-review" ? { kind, payoutId, decision: form.get("decision"), reason }
            : kind === "payout-reconcile" ? { kind, payoutId, attemptReference: form.get("attemptReference"), outcome: form.get("outcome"), reason }
              : { kind, payoutId, outcome: form.get("outcome"), reason };

    const result = await staffSellerFinanceAction(staff.id, marketId, input);
    revalidatePath("/staff/seller-finance");
    if ("orderId" in result) {
      if (result.state === "AWAITING_PAYMENT") return { success: "This order is awaiting verified payment evidence." };
      if (result.state === "AWAITING_FUNDS") return { success: "Payment recorded. Settlement evidence is still needed." };
      if (result.state === "HELD") return { success: "Settlement recorded. Funds remain on hold." };
      return { success: "Settlement updated. Review the available balance and statement entries." };
    }
    if ("version" in result) return { success: `Test policy version ${result.version} saved.` };
    return { success: "Test finance record updated." };
  } catch (error) {
    return financeFailure("staff.seller-finance", error);
  }
}
