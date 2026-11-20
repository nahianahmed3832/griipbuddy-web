"use server";

import { revalidatePath } from "next/cache";
import { getDb, type DbReader } from "@/lib/db/client";
import { reportFailure } from "@/lib/db/observability";
import { couponDirectoryShops } from "@/lib/marketplace/coupon-directory";
import { couponCodeInput, couponConfiguration } from "@/lib/marketplace/coupon-input";
import { marketplaceMode } from "@/lib/release-config";
import { getStaff } from "@/lib/staff/access";
import { parseMinorUnits } from "@/lib/staff/catalog-input";
import { authorize, OperationError } from "@/lib/staff/operations";
import { isMarketSelectable, marketConfiguration } from "@/lib/market-config";
import { marketDayStart, shiftCalendarDay } from "@/lib/market-calendar";
import { sellerVisibility } from "@/lib/marketplace/market-grants";
import type { MarketId } from "@/config/markets";

type ActionState = { error?: string; success?: string };

function endOfDay(value: FormDataEntryValue | null, timeZone: string) {
  if (!value) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(NaN);
  const tomorrow = shiftCalendarDay(value, 1);
  return tomorrow ? marketDayStart(tomorrow, timeZone) ?? new Date(NaN) : new Date(NaN);
}

async function changeCoupon(task: (db: DbReader, actorId: string) => Promise<void>, success: string): Promise<ActionState> {
  if (!marketplaceMode()) return { error: "Coupon management is unavailable." };
  const staff = await getStaff();
  if (staff?.role !== "OWNER") return { error: "Owner access is required." };
  try {
    await getDb().$transaction(async db => {
      await authorize(db, staff.id, true);
      await task(db, staff.id);
    });
    revalidatePath("/staff/coupons");
    revalidatePath("/coupons");
    revalidatePath("/account/coupons");
    return { success };
  } catch (error) {
    if (error instanceof OperationError) return { error: error.message };
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") {
      return { error: "That coupon code already exists." };
    }
    reportFailure("staff.coupon", undefined, error);
    return { error: "The coupon could not be saved. Try again." };
  }
}

export async function createCoupon(marketId: MarketId, _state: ActionState, form: FormData): Promise<ActionState> {
  if (!isMarketSelectable(marketId)) return { error: "Choose a configured market." };
  const { timeZone } = marketConfiguration(marketId);
  const limit = form.get("useLimit");
  const input = couponConfiguration.safeParse({
    code: form.get("code"),
    shopId: form.get("shop") || null,
    kind: form.get("kind"),
    value: parseMinorUnits(form.get("value")),
    minimumMinor: form.get("minimum") ? parseMinorUnits(form.get("minimum")) : 0,
    useLimit: limit === "" ? null : typeof limit === "string" && /^\d+$/.test(limit) ? Number(limit) : NaN,
    endsAt: endOfDay(form.get("endsAt"), timeZone),
  });
  if (!input.success) return { error: "Check the code, discount, minimum, end date and order limit." };
  if (input.data.endsAt && input.data.endsAt <= new Date()) return { error: "Choose a last day in the future." };
  return changeCoupon(async (db, actorId) => {
    const coupon = input.data;
    if (coupon.shopId && !await db.marketplaceShop.findFirst({ where: { id: coupon.shopId, ...sellerVisibility(marketId) }, select: { id: true } })) {
      throw new OperationError("Choose a shop approved to sell in this market.");
    }
    await db.marketplaceCoupon.create({ data: { ...coupon, marketId } });
    await db.auditEvent.create({ data: { actorId, action: "COUPON_CHANGED", target: coupon.code,
      changes: { created: true, marketId, kind: coupon.kind, value: coupon.value, minimumMinor: coupon.minimumMinor, shopId: coupon.shopId } } });
  }, "Coupon created.");
}

export async function setCouponEnabled(marketId: MarketId, code: string, enabled: boolean): Promise<ActionState> {
  const normalized = couponCodeInput.safeParse(code);
  if (!isMarketSelectable(marketId) || !normalized.success || typeof enabled !== "boolean") return { error: "Unknown coupon." };
  return changeCoupon(async (db, actorId) => {
    const updated = await db.marketplaceCoupon.updateMany({ where: { marketId, code: normalized.data, enabled: !enabled }, data: { enabled } });
    if (updated.count) {
      await db.auditEvent.create({ data: { actorId, action: "COUPON_CHANGED", target: normalized.data, changes: { marketId, enabled } } });
    }
  }, enabled ? "Coupon enabled." : "Coupon disabled.");
}

export async function setCouponDirectoryPublication(marketId: MarketId, code: string, published: boolean): Promise<ActionState> {
  const normalized = couponCodeInput.safeParse(code);
  if (!isMarketSelectable(marketId) || !normalized.success || typeof published !== "boolean") return { error: "Unknown coupon." };
  return changeCoupon(async (db, actorId) => {
    const where = { code: normalized.data, marketId };
    const coupon = await db.marketplaceCoupon.findUnique({ where, select: { publishedInDirectory: true } });
    if (!coupon) throw new OperationError("This coupon is unavailable in the selected market.");
    if (coupon.publishedInDirectory === published) return;
    const updated = await db.marketplaceCoupon.updateMany({
      where: { ...where, publishedInDirectory: !published, ...(published && {
        enabled: true,
        AND: [
          { OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }] },
          couponDirectoryShops(marketId),
        ],
      }) },
      data: { publishedInDirectory: published },
    });
    if (!updated.count) throw new OperationError("Reload and choose an eligible coupon.");
    await db.auditEvent.create({ data: { actorId, action: "COUPON_CHANGED", target: normalized.data,
      changes: { marketId, publishedInDirectory: published } } });
  }, published ? "Coupon published to the directory." : "Coupon removed from the directory.");
}
