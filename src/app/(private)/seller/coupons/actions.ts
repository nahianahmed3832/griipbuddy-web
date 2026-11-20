"use server";

import { revalidatePath } from "next/cache";
import { getShopper } from "@/lib/marketplace/auth";
import { createSellerCoupon, disableSellerCoupon } from "@/lib/marketplace/seller-coupons";
import { couponCodeInput } from "@/lib/marketplace/coupon-input";
import { reportFailure } from "@/lib/db/observability";
import { marketDayStart, shiftCalendarDay } from "@/lib/market-calendar";
import { currentMarket } from "@/lib/market-server";
import { parseMinorUnits } from "@/lib/staff/catalog-input";
import { OperationError } from "@/lib/staff/operation-error";

type State = { message?: string; error?: boolean };

export async function changeSellerCoupon(marketId: string, _state: State, form: FormData): Promise<State> {
  const market = await currentMarket();
  const shopper = await getShopper();
  if (!shopper || market.id !== marketId) return { error: true, message: "Open your shop in the selected market." };
  try {
    const action = form.get("action");
    if (action === "disable") {
      const code = couponCodeInput.safeParse(form.get("code"));
      if (!code.success) return { error: true, message: "Choose an existing coupon." };
      await disableSellerCoupon(shopper.id, market.id, code.data);
      revalidatePath("/seller/coupons");
      return { message: "Coupon disabled." };
    }
    if (action !== "create") return { error: true, message: "Choose a coupon operation." };
    const limit = String(form.get("limit") ?? "");
    const lastDay = String(form.get("ends") ?? "");
    const tomorrow = lastDay && /^\d{4}-\d{2}-\d{2}$/.test(lastDay) ? shiftCalendarDay(lastDay, 1) : null;
    await createSellerCoupon(shopper.id, market.id, { code: form.get("code"), kind: form.get("kind"),
      value: parseMinorUnits(form.get("value")), minimumMinor: form.get("minimum") ? parseMinorUnits(form.get("minimum")) : 0,
      useLimit: limit === "" ? null : /^\d+$/.test(limit) ? Number(limit) : NaN,
      endsAt: lastDay ? tomorrow && marketDayStart(tomorrow, market.timeZone) || new Date(NaN) : null });
    revalidatePath("/seller/coupons");
    return { message: "Coupon saved." };
  } catch (error) {
    if (error instanceof OperationError) return { error: true, message: error.message };
    reportFailure("seller.coupon", undefined, error);
    return { error: true, message: "The coupon could not be saved." };
  }
}
