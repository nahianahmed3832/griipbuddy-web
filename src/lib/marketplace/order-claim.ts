import type { MarketId } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";
import { checkoutInput, uuid } from "../commerce/checkout-types.ts";
import { orderRecoveryExpiry } from "../commerce/order-recovery.ts";

const sampleEmails = new Set(["checkout@example.invalid", "demo-order@example.invalid", "gateway-test@example.test"]);
const samplePhones = new Set(["+8801700000000", "+12025550100"]);

type Contact = { email: string | null; phone: string; marketId: MarketId };
type VerifiedShopper = { email: string; emailVerified: boolean; phoneNumber: string | null; phoneNumberVerified: boolean };

export function matchesVerifiedCheckoutContact(order: Contact, shopper: VerifiedShopper) {
  const email = order.email?.trim().toLowerCase();
  if (shopper.emailVerified && email && !sampleEmails.has(email) &&
      !email.endsWith("@phone.griipbuddy.invalid") && email === shopper.email.trim().toLowerCase()) return true;
  if (!shopper.phoneNumberVerified || !shopper.phoneNumber) return false;
  const normalized = order.marketId === "bd" ? checkoutInput.shape.customer.shape.phone.safeParse(order.phone).data
    : order.phone.trim().replace(/[\s().-]/g, "").replace(/^(?:\+?1)?([2-9]\d{2}[2-9]\d{6})$/, "+1$1");
  return Boolean(normalized && !samplePhones.has(normalized) && normalized === shopper.phoneNumber);
}

type ClaimInput = { orderId: string; marketId: MarketId; shopperId: string; guestKey?: string | null; trackingToken?: string };

export async function claimGuestOrder({ orderId, marketId, shopperId, guestKey, trackingToken }: ClaimInput) {
  if (!uuid.safeParse(orderId).success) return "unavailable" as const;
  const db = getDb();
  return db.$transaction(async tx => {
    // Serialize concurrent claims before checking the owner and recording the audit event.
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId}::uuid AND "marketId" = ${marketId}::"MarketCode" FOR UPDATE`;
    const order = await tx.order.findFirst({ where: { id: orderId, marketId },
      select: { id: true, marketId: true, shopperId: true, email: true, phone: true, attempt: { select: { guestKey: true } } },
    });
    if (!order || order.shopperId && order.shopperId !== shopperId) return "unavailable" as const;
    if (order.shopperId === shopperId) return "claimed" as const;
    const proof = { id: order.id, guestKey: order.attempt.guestKey };
    if (proof.guestKey !== guestKey && !orderRecoveryExpiry("link", proof, trackingToken)) return "unavailable" as const;
    const shopper = await tx.shopper.findUnique({ where: { id: shopperId },
      select: { email: true, emailVerified: true, phoneNumber: true, phoneNumberVerified: true },
    });
    if (!shopper || !matchesVerifiedCheckoutContact(order, shopper)) return "verify-contact" as const;
    await tx.order.update({ where: { id: orderId }, data: { shopperId } });
    await tx.shopperAccountEvent.create({ data: { shopperId, marketId, action: "order_claimed" } });
    return "claimed" as const;
  });
}
