import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ShopperActor } from "../access/actors.ts";
import { bindCommerceScope, commerceReferenceFor } from "../commerce/service-contract.ts";
import { getDb } from "../db/client.ts";
import { readBody } from "../db/http.ts";
import { developmentAcceptanceDatabase, localDatabase } from "../db/local.ts";
import { resolveMarketScope } from "../market-config.ts";
import { hybridDemoMode, marketplaceMode } from "../release-config.ts";

const endpoint = "/api/v1/customer-orders/link";
const authority = "legacy-commerce";
const marketId = "bd";
const currency = "BDT";

export const legacyCredentials = z.strictObject({
  phone: z.string().trim().min(10).max(28).regex(/^[+\d ()-]+$/)
    .transform(phone => phone.replace(/\D/g, "").replace(/^(?:880|88)(?=01\d{9}$)/, ""))
    .pipe(z.string().regex(/^01\d{9}$/)),
  password: z.string().min(1).max(128),
});

const attestation = z.strictObject({
  success: z.literal(true),
  data: z.strictObject({
    shopperId: z.string().min(1).max(128),
    marketId: z.literal(marketId),
    currency: z.literal(currency),
    legacyCustomer: z.strictObject({
      authority: z.literal(authority), kind: z.literal("customer"), id: z.string().regex(/^[a-f0-9]{24}$/),
    }),
  }),
});

export function configuredLegacyLink() {
  if (!marketplaceMode() || hybridDemoMode() || !resolveMarketScope(marketId, currency)) return null;
  const origin = process.env.GRIIP_LEGACY_ACCOUNT_LINK_ORIGIN;
  const token = process.env.BD_ORDER_HUB_BRIDGE_TOKEN;
  if (!origin || !token || !/^[a-f0-9]{64}$/.test(token)) return null;
  try {
    const destination = new URL(origin);
    if (destination.origin !== origin || destination.protocol !== "http:") return null;
    const local = localDatabase() === "griipbuddy_test" && destination.hostname === "127.0.0.1" && /^3\d{4}$/.test(destination.port);
    const stage = developmentAcceptanceDatabase() && origin === "http://bd-order-hub-api:38100";
    return local || stage ? { origin, token } : null;
  } catch { return null; }
}

export async function linkLegacyAccount(shopper: ShopperActor, credentials: z.output<typeof legacyCredentials>,
  config: NonNullable<ReturnType<typeof configuredLegacyLink>>) {
  const operationId = randomUUID();
  const issuedAt = String(Math.floor(Date.now() / 1000));
  const body = { marketId, currency, shopperId: shopper.id, phone: credentials.phone, password: credentials.password };
  const signed = JSON.stringify(["griip-legacy-account-link-v1", issuedAt, operationId, "POST", endpoint,
    marketId, currency, shopper.id, body.phone, body.password]);
  const signature = createHmac("sha256", Buffer.from(config.token, "hex")).update(signed).digest("hex");
  const response = await fetch(config.origin + endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-griip-bridge-time": issuedAt,
      "x-griip-operation-id": operationId, "x-griip-bridge-signature": signature,
    },
    body: JSON.stringify(body), cache: "no-store", redirect: "error", signal: AbortSignal.timeout(5_000),
  });
  if (response.status === 401) return "unverified";
  if (!response.ok) return "unavailable";
  const bytes = await readBody(response, 4096);
  if (!bytes) return "unavailable";
  let payload: unknown;
  try { payload = JSON.parse(bytes.toString("utf8")); } catch { return "unavailable"; }
  const result = attestation.safeParse(payload);
  if (!result.success || result.data.data.shopperId !== shopper.id) return "unavailable";
  const proven = result.data.data;
  const scope = bindCommerceScope({ authority: proven.legacyCustomer.authority, marketId: proven.marketId, currency: proven.currency });
  const customer = commerceReferenceFor(scope, proven.legacyCustomer.kind, proven.legacyCustomer.id);

  return getDb().$transaction(async tx => {
    await tx.shopperLegacyLink.createMany({
      data: { shopperId: shopper.id, legacyCustomerId: customer.sourceId, marketId: customer.marketId, proofOperationId: operationId },
      skipDuplicates: true,
    });
    const row = await tx.shopperLegacyLink.findUnique({ where: { shopperId: shopper.id },
      select: { legacyCustomerId: true, marketId: true },
    });
    return row?.legacyCustomerId === customer.sourceId && row.marketId === customer.marketId ? "linked" : "conflict";
  });
}
