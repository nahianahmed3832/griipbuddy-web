import { z } from "zod";
import { markets, type MarketId } from "../../config/markets.ts";
import { getDb } from "../db/client.ts";
import { textField, validationMessage } from "./catalog-input.ts";
import { authorize, OperationError } from "./operations.ts";
import { orderIntakeOpen } from "../release-config.ts";
import { marketConfiguration, marketIdInput, marketPayment } from "../market-config.ts";
import { prepaidAvailable } from "../commerce/prepaid-config.ts";

const revision = z.number().int().min(0).nullable();
const policyInput = z.object({
  marketId: marketIdInput, enabled: z.boolean(), codEnabled: z.boolean(), revision,
  taxBasisPoints: z.number().int().min(0).max(10_000).nullable(), taxLabel: textField(0, 80),
}).superRefine((value, ctx) => {
  if (value.enabled && (value.taxBasisPoints === null || !value.taxLabel)) {
    ctx.addIssue({ code: "custom", path: ["enabled"], message: "Supply an explicit tax rate and label before opening checkout." });
  }
  if ((value.taxBasisPoints === null) !== (value.taxLabel === "")) {
    ctx.addIssue({ code: "custom", path: ["taxLabel"], message: "Provide a tax label and rate together, or leave both blank." });
  }
});
const zoneInput = z.object({
  marketId: marketIdInput, district: z.string().trim().regex(/^[a-z][a-z-]{1,39}$/), districtLabel: textField(2, 80),
  method: z.string().trim().regex(/^[a-z][a-z0-9-]{1,39}$/), label: textField(2, 100), guidance: textField(0, 500),
  chargeMinor: z.number().int().min(0).max(10_000_000).nullable(), enabled: z.boolean(), codEligible: z.boolean(), revision,
}).refine(({ enabled, chargeMinor }) => !enabled || chargeMinor !== null, {
  path: ["chargeMinor"], message: "Enter a shipping charge before enabling the option. Zero must be explicit.",
});

export async function getMarketSettings(actorId: string, marketId: MarketId) {
  const db = getDb();
  await authorize(db, actorId, true);
  return db.checkoutPolicy.findUnique({
    where: { marketId }, include: { deliveryZones: { orderBy: [{ district: "asc" }, { method: "asc" }] } },
  });
}

export async function pauseMarketCheckout(actorId: string, marketId: MarketId) {
  return getDb().$transaction(async (tx) => {
    await authorize(tx, actorId, true);
    const paused = await tx.checkoutPolicy.updateMany({
      where: { marketId, enabled: true },
      data: { enabled: false, revision: { increment: 1 } },
    });
    if (paused.count) {
      await tx.auditEvent.create({
        data: { actorId, action: "MARKET_SETTINGS_CHANGED", target: marketId, changes: { enabled: false, reason: "Owner paused new orders" } },
      });
    }
  });
}

export async function saveMarketPolicy(actorId: string, raw: unknown) {
  const parsed = policyInput.safeParse(raw);
  if (!parsed.success) throw new OperationError(validationMessage(parsed.error));
  const { marketId, enabled, codEnabled, taxBasisPoints, taxLabel, revision } = parsed.data;
  if (enabled && !orderIntakeOpen()) throw new OperationError("The release operator must enable order intake before opening a market.");
  const market = marketConfiguration(marketId);
  const { currency, countryCode } = market;
  const evidence = process.env.COMMERCE_MODE === "production" ? "production" : "sandbox";
  const cod = codEnabled && marketPayment(market, "COD", evidence);
  const prepaid = marketPayment(market, "SSLCOMMERZ", evidence) && prepaidAvailable(marketId);
  if (enabled && (market.checkoutAuthority !== "native" || market.delivery.coverage !== "checkout-policy" ||
      market.pricing.taxTreatment !== "MERCHANDISE_RATE" || (!cod && !prepaid) || (codEnabled && !cod))) {
    throw new OperationError("Enable an approved payment adapter and this market’s native checkout policy before opening intake.");
  }
  await getDb().$transaction(async (tx) => {
    await authorize(tx, actorId, true);
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${marketId}), 38)`;
    await tx.$queryRaw`SELECT "marketId" FROM "CheckoutPolicy" WHERE "marketId" = ${marketId}::"MarketCode" FOR UPDATE`;
    const current = await tx.checkoutPolicy.findUnique({ where: { marketId } });
    if ((current?.revision ?? null) !== revision) throw new OperationError("Market settings changed. Reload and try again.");
    if (enabled && !await tx.deliveryZone.count({
      where: { marketId, enabled: true, ...(cod && { codEligible: true }), chargeMinor: { not: null } },
    })) {
      throw new OperationError("Add a delivery option with a configured charge and eligibility for the enabled payment method.");
    }
    const data = {
      enabled, codEnabled, currency, countryCode, taxBasisPoints,
      taxLabel: taxLabel || null, taxTreatment: taxBasisPoints === null ? null : "MERCHANDISE_RATE" as const,
    };
    await tx.checkoutPolicy.upsert({ where: { marketId }, create: { marketId, ...data }, update: { ...data, revision: { increment: 1 } } });
    await tx.auditEvent.create({
      data: { actorId, action: "MARKET_SETTINGS_CHANGED", target: marketId, changes: data },
    });
  });
}

export async function saveDeliveryZone(actorId: string, raw: unknown) {
  const parsed = zoneInput.safeParse(raw);
  if (!parsed.success) throw new OperationError(validationMessage(parsed.error));
  const { marketId, district, method, revision, ...fields } = parsed.data;
  const key = { marketId, district, method };
  await getDb().$transaction(async (tx) => {
    await authorize(tx, actorId, true);
    await tx.$queryRaw`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${marketId}), 38)`;
    const { currency, countryCode } = markets[marketId];
    await tx.checkoutPolicy.upsert({ where: { marketId }, create: { marketId, countryCode, currency }, update: {} });
    await tx.$queryRaw`SELECT "marketId" FROM "CheckoutPolicy" WHERE "marketId" = ${marketId}::"MarketCode" FOR UPDATE`;
    const current = await tx.deliveryZone.findUnique({ where: { marketId_district_method: key } });
    if ((current?.revision ?? null) !== revision) throw new OperationError("This delivery option already exists or changed. Reload and try again.");
    const data = { ...fields, guidance: fields.guidance || null };
    await tx.deliveryZone.upsert({
      where: { marketId_district_method: key }, create: { ...key, ...data }, update: { ...data, revision: { increment: 1 } },
    });
    await tx.auditEvent.create({
      data: { actorId, action: "MARKET_SETTINGS_CHANGED", target: `${marketId}/${district}/${method}`, changes: data },
    });
  });
}
