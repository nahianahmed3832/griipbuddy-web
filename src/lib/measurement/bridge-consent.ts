import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import { marketConfiguration } from "../market-config.ts";
import { stableMeasurementId } from "./domain.ts";
import { cookieId, hasStaffMeasurementSession, measurementEnabled } from "./server.ts";
import { bridgeHandoffProof, bridgeLines, configuredBridge, OutcomeBridgeError, type BridgeBinding, type BridgeLine } from "./bridge-contract.ts";

const checkoutSessionSeconds = 30 * 60;
const handoffSeconds = 15 * 60;
const proofDomain = "griipbuddy-legacy-checkout-handoff-v1\0";

function handoffKey(binding: BridgeBinding) {
  if (binding.scope !== "isolated-fixture") return null;
  const key = process.env.GRIIP_OUTCOME_HANDOFF_SECRET;
  return key && key.length >= 32 && key.length <= 512 && key !== binding.secret && key !== process.env.CHECKOUT_SECRET ? key : null;
}

export function canonicalBridgeLines(lines: readonly BridgeLine[]) {
  const quantities = new Map<string, number>();
  for (const { variantId, quantity } of lines) quantities.set(variantId, (quantities.get(variantId) ?? 0) + quantity);
  return [...quantities].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}

function digestCart(lines: readonly BridgeLine[]) {
  return createHash("sha256").update(JSON.stringify(canonicalBridgeLines(lines))).digest("hex");
}

function proofSignature(authority: string, claims: string, key: string) {
  return createHmac("sha256", key).update(proofDomain).update(authority + "\0" + claims).digest();
}

function proofId(binding: BridgeBinding, nonce: string) {
  return stableMeasurementId("bridge-handoff", binding.authority, binding.marketId, nonce);
}

export async function provisionBridgeHandoff(input: {
  headers: Headers;
  consentCookie: string | null | undefined;
  sessionId: string | null | undefined;
  marketId: MarketId;
  lines: readonly BridgeLine[];
}): Promise<string | null> {
  const binding = configuredBridge();
  const sessionId = z.uuidv4().safeParse(input.sessionId);
  if (!binding || binding.marketId !== input.marketId || !sessionId.success ||
      !measurementEnabled() || marketConfiguration(input.marketId).analytics.structured !== "first-party" ||
      input.headers.get("sec-gpc") === "1" || hasStaffMeasurementSession(input.headers) ||
      !bridgeLines.safeParse(input.lines).success) return null;
  const key = handoffKey(binding);
  if (!key) return null;
  const journeyId = cookieId(input.consentCookie ?? undefined);
  if (!journeyId) return null;

  const db = getDb();
  const now = new Date();
  const journey = await db.measurementJourney.findFirst({
    where: { id: journeyId, test: true, expiresAt: { gt: now },
      events: { some: { marketId: binding.marketId, sessionId: sessionId.data, kind: "CHECKOUT_START",
        at: { gte: new Date(+now - checkoutSessionSeconds * 1000), lte: now } } },
    },
    select: { expiresAt: true },
  });
  if (!journey) return null;
  const expiry = Math.min(Math.floor(+journey.expiresAt / 1000), Math.floor(+now / 1000) + handoffSeconds);
  if (expiry * 1000 <= +now) return null;
  const nonce = randomBytes(32).toString("hex");
  const cartDigest = digestCart(input.lines);
  const claims = [nonce, expiry, binding.marketId, cartDigest].join(".");
  try {
    await db.bridgeMeasurement.create({
      data: { id: proofId(binding, nonce), authority: binding.authority, marketId: binding.marketId, cartDigest,
        journeyId, sessionId: sessionId.data, issuedAt: now, expiresAt: new Date(expiry * 1000) },
    });
  } catch (error) {
    // Consent can be withdrawn between the read and the write.
    if (typeof error === "object" && error && "code" in error && error.code === "P2003") return null;
    throw error;
  }
  return claims + "." + proofSignature(binding.authority, claims, key).toString("hex");
}

export async function attachBridgeHandoff(
  tx: Prisma.TransactionClient,
  binding: BridgeBinding,
  order: { id: string; createdAt: Date; lines: readonly BridgeLine[]; linkProof: string },
  now: Date,
) {
  const key = handoffKey(binding);
  const proof = bridgeHandoffProof.exec(order.linkProof);
  if (!key || !proof || proof[3] !== binding.marketId || proof[4] !== digestCart(order.lines)) return false;
  const [, nonce, expiry, marketId, digest, mac] = proof;
  const claims = [nonce, expiry, marketId, digest].join(".");
  if (!timingSafeEqual(Buffer.from(mac, "hex"), proofSignature(binding.authority, claims, key))) return false;
  const handoff = await tx.bridgeMeasurement.findUnique({
    where: { id: proofId(binding, nonce) },
    select: { id: true, orderId: true, issuedAt: true, expiresAt: true, cartDigest: true, authority: true, marketId: true,
      journey: { select: { test: true, expiresAt: true } } },
  });
  if (!handoff || handoff.authority !== binding.authority || handoff.marketId !== binding.marketId ||
      !handoff.journey.test || handoff.journey.expiresAt <= now || handoff.cartDigest !== digest ||
      +handoff.expiresAt !== Number(expiry) * 1000 || order.createdAt < handoff.issuedAt ||
      order.createdAt > handoff.expiresAt) return false;
  if (handoff.orderId) {
    if (handoff.orderId !== order.id) throw new OutcomeBridgeError("Handoff proof was already consumed by a different order.");
    return false;
  }
  const linked = await tx.bridgeMeasurement.updateMany({ where: { id: handoff.id, orderId: null }, data: { orderId: order.id } });
  if (linked.count) await tx.bridgeOrder.update({ where: { id: order.id }, data: { measurementClaimed: true } });
  return linked.count === 1;
}
