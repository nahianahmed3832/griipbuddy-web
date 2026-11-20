import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Currency, MarketId } from "../../config/markets.ts";
import {
  bindCommerceScope, CommerceContractError, commerceAuthorityId, commerceCurrency, commerceMarketId,
  commerceSourceId, validateCommerceMoney,
} from "../commerce/service-contract.ts";
import { developmentAcceptanceDatabase, localDatabase, stagingDatabase } from "../db/local.ts";
import { marketConfiguration } from "../market-config.ts";

export const bridgeSignatureDomain = "griipbuddy-outcome-bridge:v1\n";
export const bridgeMaxSignedBytes = 256 * 1024;
const minor = z.int().min(0).max(2_147_483_647);
const occurredAt = z.iso.datetime({ precision: 3 });
const bridgeKind = z.enum(["ORDER_ACCEPTED", "ORDER_DELIVERED", "COD_COLLECTED", "COD_REMITTED"]);
export const bridgeHandoffProof = /^([a-f0-9]{64})\.(\d{10})\.([a-z][a-z0-9-]{1,15})\.([a-f0-9]{64})\.([a-f0-9]{64})$/;

const outcome = z.strictObject({
  sourceEventId: commerceSourceId,
  kind: bridgeKind,
  at: occurredAt,
  amountMinor: minor.nullish(),
  grossMinor: minor.nullish(),
  deductionsMinor: minor.nullish(),
});
export const bridgeLines = z.array(z.strictObject({
  variantId: z.string().regex(/^v-[A-Za-z0-9_-]{1,98}$/), quantity: z.int().min(1).max(1000),
})).min(1).max(50);
export type BridgeLine = z.output<typeof bridgeLines>[number];
const order = z.strictObject({
  sourceOrderId: commerceSourceId,
  currency: commerceCurrency,
  paymentMethod: z.literal("COD"),
  bookedAt: occurredAt,
  subtotalMinor: minor.nullish(),
  discountMinor: minor.nullish(),
  taxMinor: minor.nullish(),
  deliveryMinor: minor.nullish(),
  totalMinor: minor,
  lines: bridgeLines.nullish(),
  events: z.array(outcome).min(1).max(4),
  linkProof: z.string().regex(bridgeHandoffProof).optional(),
});
const envelope = z.strictObject({
  version: z.literal(1),
  authority: commerceAuthorityId,
  marketId: commerceMarketId,
  evidence: z.literal("fixture"),
  orders: z.array(order).min(1).max(100),
});

export type BridgeEnvelope = z.output<typeof envelope>;
export type BridgeOrderInput = z.output<typeof order>;
export type BridgeBinding = {
  authority: string;
  marketId: MarketId;
  currency: Currency;
  secret: string;
  scope: "isolated-fixture" | "development-report";
};

export class OutcomeBridgeError extends CommerceContractError {
  constructor(message: string, code: CommerceContractError["code"] = "invalid_input") {
    super(code, message);
    this.name = "OutcomeBridgeError";
  }
}

export function configuredBridge(): BridgeBinding | null {
  const env = process.env;
  if (env.GRIIP_OUTCOME_BRIDGE_ENABLED !== "1") return null;
  const isolated = localDatabase() === "griipbuddy_test" || (env.GRIIP_MARKET_REVIEW_FIXTURES === "1" && stagingDatabase());
  const developmentReport = developmentAcceptanceDatabase() && env.GRIIP_OUTCOME_BRIDGE_USE_LEGACY_CHECKOUT !== "1";
  if (!isolated && !developmentReport) return null;
  const authority = commerceAuthorityId.safeParse(env.GRIIP_OUTCOME_BRIDGE_AUTHORITY);
  const marketId = commerceMarketId.safeParse(env.GRIIP_OUTCOME_BRIDGE_MARKET);
  const secret = env.GRIIP_OUTCOME_BRIDGE_SECRET;
  if (!authority.success || !marketId.success || !secret || secret.length < 32 || secret.length > 512) return null;
  const market = marketConfiguration(marketId.data);
  if (market.status !== "staging" || !market.payments.some(payment => payment.method === "COD" && payment.enabled && payment.evidence === "sandbox")) return null;
  const scope = bindCommerceScope({ authority: authority.data, marketId: market.id, currency: market.currency });
  return { ...scope, secret, scope: isolated ? "isolated-fixture" : "development-report" };
}

function invalid(message: string): never {
  throw new OutcomeBridgeError(message);
}

function validateOrder(row: BridgeOrderInput, binding: BridgeBinding, now: Date) {
  try {
    validateCommerceMoney(binding, { currency: row.currency, amountMinor: row.totalMinor });
  } catch (error) {
    if (error instanceof CommerceContractError && error.code === "market_mismatch") {
      throw new OutcomeBridgeError("Order currency differs from the configured market.", error.code);
    }
    throw error;
  }
  const { subtotalMinor, discountMinor, taxMinor, deliveryMinor, totalMinor, events } = row;
  if (subtotalMinor != null && discountMinor != null && discountMinor > subtotalMinor) invalid("Order discount exceeds its merchandise subtotal.");
  if (subtotalMinor != null && discountMinor != null && taxMinor != null && deliveryMinor != null &&
      subtotalMinor - discountMinor + taxMinor + deliveryMinor !== totalMinor) invalid("Order amounts do not reconcile.");
  const expected = bridgeKind.options;
  const byKind = new Map(events.map(event => [event.kind, event]));
  if (byKind.size !== events.length || expected.slice(0, events.length).some(kind => !byKind.has(kind))) {
    invalid("Order lifecycle has duplicate or missing prerequisite outcomes.");
  }
  const booked = byKind.get("ORDER_ACCEPTED")!;
  if (booked.at !== row.bookedAt || booked.amountMinor !== totalMinor) invalid("Order acceptance differs from the committed booking.");

  let prior = +new Date(row.bookedAt);
  for (const kind of expected.slice(0, events.length)) {
    const event = byKind.get(kind)!;
    const at = +new Date(event.at);
    if (!Number.isFinite(at) || at < prior || at > +now + 5 * 60_000) invalid("Order lifecycle timestamps are out of sequence.");
    prior = at;
    if (kind !== "COD_REMITTED" && (event.grossMinor != null || event.deductionsMinor != null)) invalid("Only remittance carries gross and deduction amounts.");
    if (kind === "ORDER_DELIVERED" && event.amountMinor != null) invalid("Delivery carries no payment amount.");
    if (kind === "COD_COLLECTED" && (totalMinor <= 0 || event.amountMinor !== totalMinor)) invalid("COD collection differs from the booked amount.");
    if (kind === "COD_REMITTED" && (event.grossMinor !== totalMinor || event.deductionsMinor == null ||
        event.deductionsMinor > totalMinor || event.amountMinor !== totalMinor - event.deductionsMinor)) {
      invalid("COD remittance amounts do not reconcile.");
    }
  }
}

export function readSignedBridge(signed: Buffer, binding: BridgeBinding, now = new Date()): BridgeEnvelope {
  if (signed.length > bridgeMaxSignedBytes || signed[64] !== 10) invalid("Invalid signed bridge envelope.");
  const signature = signed.subarray(0, 64).toString("utf8");
  const body = signed.subarray(65);
  const expected = createHmac("sha256", binding.secret).update(bridgeSignatureDomain).update(body).digest();
  if (!/^[a-f0-9]{64}$/.test(signature) || !timingSafeEqual(Buffer.from(signature, "hex"), expected)) {
    throw new OutcomeBridgeError("Bridge signature verification failed.", "forbidden");
  }
  let decoded: unknown;
  try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { invalid("Bridge body must contain valid UTF-8 JSON."); }
  const result = envelope.safeParse(decoded);
  if (!result.success) invalid("Unsupported bridge version or order fields.");
  const data = result.data;
  if (data.authority !== binding.authority || data.marketId !== binding.marketId) {
    throw new OutcomeBridgeError("Bridge authority or market differs from the configured route.", "market_mismatch");
  }
  if (new Set(data.orders.map(row => row.sourceOrderId)).size !== data.orders.length) invalid("Bridge batch repeats a source order.");
  const eventIds = new Set<string>();
  for (const row of data.orders) {
    validateOrder(row, binding, now);
    for (const event of row.events) {
      if (eventIds.has(event.sourceEventId)) invalid("Bridge batch repeats a source event.");
      eventIds.add(event.sourceEventId);
    }
  }
  return data;
}
