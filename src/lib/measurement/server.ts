import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import { MAX_QUANTITY } from "../cart/model.ts";
import { getDb } from "../db/client.ts";
import { productionMode } from "../release-config.ts";
import { acquisitionCampaign } from "./campaign.ts";
import { journeySeconds, measurementRetentionDays, stableMeasurementId, vettedCampaign } from "./domain.ts";

export const measurementCookie = "griipbuddy-measurement";
export const choiceSeconds = measurementRetentionDays * 86_400;
export const measurementEnabled = () => process.env.ACQUISITION_MEASUREMENT === "1";
const tokenPattern = /^([a-f0-9]{64})\.(\d{10})\.([a-f0-9]{64})$/;

function signature(payload: string) {
  const secret = process.env.CHECKOUT_SECRET;
  if (!secret || secret.length < 32) throw new Error("Missing checkout signing secret");
  return createHmac("sha256", secret).update("acquisition-consent\0").update(payload).digest("hex");
}

export function cookieId(value: string | undefined, permitExpired = false) {
  const match = value && tokenPattern.exec(value);
  if (!match || (!permitExpired && Number(match[2]) <= Math.floor(Date.now() / 1000))) return null;
  const expected = signature(`${match[1]}.${match[2]}`);
  if (!timingSafeEqual(Buffer.from(match[3], "hex"), Buffer.from(expected, "hex"))) return null;
  return stableMeasurementId("consent", match[1]);
}

export async function grantMeasurement() {
  const token = randomBytes(32).toString("hex");
  const expires = Math.floor(Date.now() / 1000) + choiceSeconds;
  const payload = `${token}.${expires}`;
  await getDb().measurementJourney.create({
    data: {
      id: stableMeasurementId("consent", token),
      test: !productionMode(), expiresAt: new Date((expires - choiceSeconds + journeySeconds) * 1000),
    },
  });
  return `${payload}.${signature(payload)}`;
}

export async function revokeMeasurement(token: string | undefined) {
  const id = cookieId(token, true);
  if (id) await getDb().measurementJourney.deleteMany({ where: { id } });
}

export async function pruneMeasurement(now = new Date()) {
  const inactiveSince = new Date(+now - measurementRetentionDays * 86_400_000);
  return (await getDb().measurementJourney.deleteMany({ where: { grantedAt: { lt: inactiveSince } } })).count;
}

const catalogueId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const uuid = z.uuid();
const campaign = z.strictObject({
  utm_source: z.string().max(32), utm_medium: z.string().max(32),
  utm_campaign: z.string().max(64), utm_content: z.string().max(64),
});

export const measurementInput = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("allow") }),
  z.strictObject({ action: z.literal("withdraw") }),
  z.strictObject({
    action: z.literal("PRODUCT_VIEW"), nonce: uuid, variantId: catalogueId, campaign: campaign.optional(),
  }),
  z.strictObject({
    action: z.literal("CART_ADD"), nonce: uuid, variantId: catalogueId, quantity: z.number().int().min(1).max(MAX_QUANTITY),
  }),
  z.strictObject({ action: z.literal("CHECKOUT_START"), nonce: uuid }),
]);

export type MeasurementInput = z.infer<typeof measurementInput>;

export async function recordMeasurement(journeyId: string, marketId: MarketId, input: Exclude<MeasurementInput, { action: "allow" | "withdraw" }>) {
  const db = getDb();
  const now = new Date();
  const journey = await db.measurementJourney.findFirst({
    where: { id: journeyId, expiresAt: { gt: now } }, select: { test: true },
  });
  if (!journey) return false;
  let productId: string | null = null;
  let variantId: string | null = null;
  let quantity: number | null = null;
  let campaign: string | null = null;
  if (input.action !== "CHECKOUT_START") {
    const variant = await db.variant.findFirst({
      where: {
        id: input.variantId, active: true,
        product: { active: true, publication: "ACTIVE", ...(journey.test ? {} : { demo: false }) },
      },
      select: {
        id: true, productId: true,
        offers: { where: { marketId, eligible: true }, select: { variantId: true } },
      },
    });
    if (!variant || (input.action === "CART_ADD" && !variant.offers.length)) return false;
    productId = variant.productId;
    variantId = variant.id;
    if (input.action === "CART_ADD") quantity = input.quantity;
    else campaign = vettedCampaign(input.campaign, marketId === acquisitionCampaign.marketId &&
      variantId === acquisitionCampaign.variantId && productId === acquisitionCampaign.productId);
  }
  const id = stableMeasurementId("observation", journeyId, input.action, input.nonce);
  await db.measurementEvent.createMany({
    data: { id, journeyId, kind: input.action, marketId, productId, variantId, quantity, campaign, at: now },
    skipDuplicates: true,
  });
  return true;
}

export async function linkAcceptedOrder(orderId: string, guestKey: string, journeyId: string) {
  // Only called with an ID returned by the authoritative checkout submit/recover.
  // The unique order key makes retries safe; use the earliest complete linkage.
  await getDb().$executeRaw`
    INSERT INTO "MeasurementOrder" ("orderId", "journeyId")
    SELECT o.id, j.id
    FROM "Order" o
    JOIN "CheckoutAttempt" a ON a.id = o."attemptId"
    JOIN "MeasurementJourney" j ON j.id = ${journeyId}
    WHERE o.id = ${orderId}::uuid AND a."guestKey" = ${guestKey}
      AND o."measurementTest" = j.test
      AND j."grantedAt" <= o."createdAt" AND j."expiresAt" > o."createdAt" AND j."expiresAt" > CURRENT_TIMESTAMP
      AND EXISTS (
        SELECT 1 FROM "MeasurementEvent" e
        WHERE e."journeyId" = j.id AND e."marketId" = o."marketId"
          AND e.kind = 'CHECKOUT_START' AND e.at >= j."grantedAt" AND e.at <= o."createdAt"
      )
    ON CONFLICT ("orderId") DO NOTHING
  `;
}
