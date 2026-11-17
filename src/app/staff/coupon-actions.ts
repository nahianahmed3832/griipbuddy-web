"use server";

import { revalidatePath } from "next/cache";
import { getDb, type DbReader } from "@/lib/db/client";
import { reportFailure } from "@/lib/db/observability";
import { couponCodeInput, couponConfiguration } from "@/lib/marketplace/coupon-input";
import { marketplaceMode } from "@/lib/release-config";
import { getStaff } from "@/lib/staff/access";
import { parseMinorUnits } from "@/lib/staff/catalog-input";
import { authorize, OperationError } from "@/lib/staff/operations";

type ActionState = { error?: string; success?: string };

function endOfDay(value: FormDataEntryValue | null) {
  if (!value) return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(NaN);
  const utc = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(utc.getTime()) || utc.toISOString().slice(0, 10) !== value) return new Date(NaN);
  const dayStart = new Date(`${value}T00:00:00+06:00`);
  return new Date(dayStart.getTime() + 86_400_000);
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

export async function createCoupon(_state: ActionState, form: FormData): Promise<ActionState> {
  const limit = form.get("useLimit");
  const input = couponConfiguration.safeParse({
    code: form.get("code"),
    shopId: form.get("shop") || null,
    kind: form.get("kind"),
    value: parseMinorUnits(form.get("value")),
    minimumMinor: form.get("minimum") ? parseMinorUnits(form.get("minimum")) : 0,
    useLimit: limit === "" ? null : typeof limit === "string" && /^\d+$/.test(limit) ? Number(limit) : NaN,
    endsAt: endOfDay(form.get("endsAt")),
  });
  if (!input.success) return { error: "Check the code, discount, minimum, end date and order limit." };
  if (input.data.endsAt && input.data.endsAt <= new Date()) return { error: "Choose a last day in the future." };
  return changeCoupon(async (db, actorId) => {
    const coupon = input.data;
    if (coupon.shopId && !await db.marketplaceShop.findFirst({ where: { id: coupon.shopId, published: true }, select: { id: true } })) {
      throw new OperationError("Choose a published shop.");
    }
    await db.marketplaceCoupon.create({ data: coupon });
    await db.auditEvent.create({ data: { actorId, action: "COUPON_CHANGED", target: coupon.code,
      changes: { created: true, kind: coupon.kind, value: coupon.value, minimumMinor: coupon.minimumMinor, shopId: coupon.shopId } } });
  }, "Coupon created.");
}

export async function setCouponEnabled(code: string, enabled: boolean): Promise<ActionState> {
  const normalized = couponCodeInput.safeParse(code);
  if (!normalized.success || typeof enabled !== "boolean") return { error: "Unknown coupon." };
  return changeCoupon(async (db, actorId) => {
    const updated = await db.marketplaceCoupon.updateMany({ where: { code: normalized.data, enabled: !enabled }, data: { enabled } });
    if (updated.count) {
      await db.auditEvent.create({ data: { actorId, action: "COUPON_CHANGED", target: normalized.data, changes: { enabled } } });
    }
  }, enabled ? "Coupon enabled." : "Coupon disabled.");
}
