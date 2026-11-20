import { randomUUID } from "node:crypto";
import type { PrismaClient } from "../../src/generated/prisma/client.ts";
import { legacyLocationId } from "../../src/lib/commerce/location-inventory.ts";
import { requireLocalDatabase } from "../../src/lib/db/local.ts";

type HistoricalFixtureInput = { key: string; productId: string; variantId: string; sku: string; slug: string };
const purchasedAt = new Date("2024-02-01T10:00:00.000Z");

export async function createMigrationHistoryFixture(db: PrismaClient, input: HistoricalFixtureInput) {
  requireLocalDatabase("griipbuddy_test");
  const { key, productId, variantId, sku, slug } = input;
  const [attemptId, orderId, lineId, parcelId, returnId, shopperId] = Array.from({ length: 6 }, () => randomUUID());
  const providerId = `paid-${attemptId.slice(0, 18)}`;
  const reference = `MIGRATION-QA-${key}-${attemptId.slice(0, 8)}`;
  const currency = "BDT" as const;
  const productName = `Purchased ${slug}`;
  const variantName = "Original Model / Original Design";
  const unitPriceMinor = 116_700;
  const unitDiscountMinor = 500;
  const lineTotalMinor = unitPriceMinor - unitDiscountMinor;

  await db.$transaction(async tx => {
    await tx.shopper.create({ data: {
      id: shopperId, name: "Synthetic migration shopper", email: `migration-${shopperId}@example.invalid`,
      favorites: { create: { productId } },
      lists: { create: { name: "Migration fixture list", items: { create: { productId } } } },
      variantWatches: { create: { variantId, marketId: "bd", priceDrop: true } },
      cart: { create: { items: [{ variantId, quantity: 1 }], saved: [{ variantId, quantity: 2 }] } },
    } });
    await tx.checkoutAttempt.create({ data: {
      id: attemptId, guestKey: attemptId, requestHash: attemptId, marketId: "bd", paymentMethod: "SSLCOMMERZ",
      commerceEvidence: "fixture", createdAt: purchasedAt,
      prepaid: { create: {
        providerId, bankTransactionId: `fixture-bank-${attemptId}`, state: "PAID", expiresAt: purchasedAt,
      } },
    } });
    await tx.order.create({ data: {
      id: orderId, attemptId, shopperId, reference, marketId: "bd", currency, status: "PLACED", fulfillmentStatus: "DELIVERED",
      customerName: "Synthetic migration shopper", phone: "00000000000", district: "dhaka", districtLabel: "Dhaka",
      locality: "Fixture locality", address: "Fixture address", deliveryMethod: "standard", deliveryLabel: "Standard",
      taxLabel: "Tax", subtotalMinor: unitPriceMinor, discountMinor: unitDiscountMinor, deliveryMinor: 0, taxMinor: 0,
      totalMinor: lineTotalMinor, measurementTest: true, commerceEvidence: "fixture", createdAt: purchasedAt,
      payment: { create: { method: "SSLCOMMERZ", status: "PAID", currency, amountMinor: lineTotalMinor, collectedAt: purchasedAt } },
      events: { create: { type: "STATUS_CHANGED", status: "DELIVERED", createdAt: purchasedAt } },
      items: { create: {
        id: lineId, variantId, sku, productName, variantName, quantity: 1, currency,
        unitPriceMinor, unitDiscountMinor, lineTotalMinor,
      } },
    } });
    await tx.orderParcel.create({ data: {
      id: parcelId, orderId, locationId: legacyLocationId, locationName: "Shared dispatch", status: "DELIVERED",
      carrier: "Fixture carrier", trackingReference: `QA-${parcelId}`, source: "MANUAL",
      items: { create: { orderItemId: lineId, quantity: 1 } },
    } });
    await tx.orderCase.create({ data: {
      id: returnId, orderId, kind: "RETURN", status: "RESOLVED", returnReceivedAt: purchasedAt, returnDisposition: "HOLD",
      returnLines: { create: { orderItemId: lineId, quantity: 1 } },
    } });
  });

  async function cleanup() {
    requireLocalDatabase("griipbuddy_test");
    await db.$transaction(async tx => {
      await tx.orderCase.deleteMany({ where: { id: returnId } });
      await tx.orderParcel.deleteMany({ where: { id: parcelId } });
      await tx.fulfillmentEvent.deleteMany({ where: { orderId } });
      await tx.payment.deleteMany({ where: { orderId } });
      await tx.orderItem.deleteMany({ where: { id: lineId } });
      await tx.order.deleteMany({ where: { id: orderId } });
      await tx.checkoutAttempt.deleteMany({ where: { id: attemptId } });
      await tx.shopper.deleteMany({ where: { id: shopperId } });
    });
  }

  return { orderId, attemptId, lineId, parcelId, returnId, shopperId, providerId, reference, productName, variantName,
    sku, unitPriceMinor, unitDiscountMinor, lineTotalMinor, currency, cleanup };
}

export async function createActiveMigrationHold(db: PrismaClient, input: { key: string; variantId: string; locationId?: string }) {
  requireLocalDatabase("griipbuddy_test");
  const { key, variantId, locationId = legacyLocationId } = input;
  const attemptId = randomUUID();
  const providerId = `hold-${attemptId.slice(0, 18)}`;
  const quantity = 1;
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  await db.checkoutAttempt.create({ data: {
    id: attemptId, guestKey: attemptId, requestHash: key.slice(0, 64), marketId: "bd", paymentMethod: "SSLCOMMERZ",
    commerceEvidence: "fixture",
    prepaid: { create: {
      providerId, state: "AWAITING_PAYMENT", expiresAt, stockAllocations: [{ variantId, locationId, quantity }],
    } },
  } });

  async function cleanup() {
    requireLocalDatabase("griipbuddy_test");
    await db.checkoutAttempt.deleteMany({ where: { id: attemptId } });
  }

  return { attemptId, providerId, expiresAt, quantity, cleanup };
}
