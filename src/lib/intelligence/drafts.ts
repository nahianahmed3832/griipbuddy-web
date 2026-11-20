import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isMarketId, type MarketId } from "../../config/markets.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { marketDay } from "../market-calendar.ts";
import { marketConfiguration } from "../market-config.ts";
import { stableMeasurementId } from "../measurement/domain.ts";
import { canUseMarket } from "../staff/market-access.ts";
import { OperationError } from "../staff/operations.ts";
import { intelligencePath } from "./navigation.ts";

export const draftTypes = {
  COLLECTION: "Draft collection", PRODUCT_TEST: "Product-test plan", PURCHASING: "Purchasing proposal",
} as const;
export const draftOutcomes = { POSITIVE: "Positive signal", NEGATIVE: "Negative signal", INCONCLUSIVE: "Inconclusive" } as const;
type DraftKind = keyof typeof draftTypes;

const day = z.iso.date();
const identifier = z.string().min(1).max(120);
const market = z.custom<MarketId>(isMarketId);
export const draftEvidenceInput = z.strictObject({
  sourceId: identifier, marketId: market, test: z.boolean(), from: day, to: day,
  title: z.string().min(1).max(220), facts: z.array(z.string().min(1).max(400)).max(6),
  hypothesis: z.string().max(500), href: z.string().max(600),
  productId: identifier.optional(), variantId: identifier.optional(), quantity: z.number().int().positive().max(1_000_000).optional(),
}).refine(input => {
  if (input.from > input.to || !input.href.startsWith(`${intelligencePath}?`)) return false;
  const href = new URL(input.href, "https://app.invalid");
  return href.pathname === intelligencePath && href.searchParams.get("market") === input.marketId &&
    href.searchParams.get("scope") === (input.test ? "test" : "live");
});
export type DraftEvidence = z.infer<typeof draftEvidenceInput>;

const tokenInput = z.object({ evidence: draftEvidenceInput, expires: z.number().int() }).strict();
const tokenLifetime = 7_200_000;

function signature(actorId: string, payload: string) {
  const secret = process.env.CHECKOUT_SECRET;
  if (!secret || secret.length < 32) return null;
  return createHmac("sha256", secret).update(JSON.stringify(["intelligence-draft-v1", actorId, payload])).digest();
}

export function signDraftEvidence(actorId: string, input: DraftEvidence, now = Date.now()) {
  const evidence = draftEvidenceInput.safeParse(input);
  if (!evidence.success) return null;
  const payload = Buffer.from(JSON.stringify({ evidence: evidence.data, expires: now + tokenLifetime })).toString("base64url");
  const signed = signature(actorId, payload);
  return signed ? `${payload}.${signed.toString("hex")}` : null;
}

export function verifyDraftEvidence(actorId: string, value: unknown, now = Date.now()) {
  if (typeof value !== "string" || value.length > 12_000) return null;
  const parts = value.match(/^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/);
  if (!parts) return null;
  const expected = signature(actorId, parts[1]);
  if (!expected || !timingSafeEqual(expected, Buffer.from(parts[2], "hex"))) return null;
  try {
    const parsed = tokenInput.parse(JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")));
    return parsed.expires > now && parsed.expires <= now + tokenLifetime ? parsed.evidence : null;
  } catch { return null; }
}

export async function canCreateIntelligenceDraft(actorId: string, marketId: MarketId, kind: DraftKind, db: DbReader = getDb()) {
  const canReport = await canUseMarket(actorId, marketId, "reporting", db);
  return canReport && await canUseMarket(actorId, marketId, kind === "PURCHASING" ? "operations" : "merchandising", db);
}

async function lockDraftPermission(db: DbReader, actorId: string, marketId: MarketId, kind: DraftKind) {
  await db.$queryRaw`SELECT "userId" FROM "StaffAccess" WHERE "userId" = ${actorId} FOR SHARE`;
  await db.$queryRaw`SELECT "userId" FROM "StaffMarketAccess" WHERE "userId" = ${actorId} AND "marketId" = ${marketId}::"MarketCode" FOR SHARE`;
  if (!await canCreateIntelligenceDraft(actorId, marketId, kind, db)) throw new OperationError("This market draft is unavailable to your account.");
}

const asDay = (value: string) => new Date(`${value}T00:00:00.000Z`);
export const draftDay = (value: Date) => value.toISOString().slice(0, 10);

export async function saveIntelligenceDraft(actorId: string, kind: DraftKind, token: unknown) {
  const evidence = verifyDraftEvidence(actorId, token);
  if (!evidence) throw new OperationError("Reload the insight before creating a draft.");
  if (kind !== "PRODUCT_TEST" && !evidence.productId) throw new OperationError("Choose an insight with an existing product.");
  const { marketId, test, sourceId, from, to } = evidence;
  const id = stableMeasurementId("intelligence-draft-v1", marketId, String(test), kind, sourceId, from, to);
  return getDb().$transaction(async tx => {
    await lockDraftPermission(tx, actorId, marketId, kind);
    const saved = await tx.intelligenceDraft.createMany({ skipDuplicates: true, data: {
      id, marketId, test, kind, sourceId, from: asDay(from), through: asDay(to), evidence, actorId,
    } });
    if (saved.count) await tx.auditEvent.create({ data: { action: "MERCHANDISING_REVIEW", actorId, target: id,
      changes: { step: "intelligence-draft-created", marketId, test, kind, sourceId } } });
    return evidence;
  });
}

const outcomeInput = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  result: z.enum(["POSITIVE", "NEGATIVE", "INCONCLUSIVE"]), from: day, to: day,
  note: z.string().trim().min(1).max(500).refine(value => !/[<>\p{Cc}]/u.test(value)),
});

export async function recordIntelligenceOutcome(actorId: string, input: unknown, now = new Date()) {
  const parsed = outcomeInput.safeParse(input);
  if (!parsed.success) throw new OperationError("Choose valid observation dates and a short evidence note.");
  const { id, result, from, to, note } = parsed.data;
  return getDb().$transaction(async tx => {
    const draft = await tx.intelligenceDraft.findUnique({ where: { id }, select: { marketId: true, kind: true, test: true, through: true } });
    if (!draft) throw new OperationError("This market draft is unavailable to your account.");
    await lockDraftPermission(tx, actorId, draft.marketId, draft.kind);
    if (from <= draftDay(draft.through) || from > to || to >= marketDay(now, marketConfiguration(draft.marketId).timeZone)) {
      throw new OperationError("Choose a completed observation period after the source window.");
    }
    const observationId = stableMeasurementId("intelligence-draft-observation", id, result, from, to, note);
    const stored = await tx.intelligenceDraftObservation.createMany({ skipDuplicates: true, data: {
      id: observationId, draftId: id, actorId, result, from: asDay(from), through: asDay(to), note,
    } });
    if (stored.count) await tx.auditEvent.create({ data: { action: "MERCHANDISING_REVIEW", actorId, target: id,
      changes: { step: "intelligence-outcome-recorded", observationId, result, from, to } } });
    return draft;
  });
}

export async function listIntelligenceDrafts(actorId: string, marketId: MarketId, test: boolean) {
  const db = getDb();
  if (!await canUseMarket(actorId, marketId, "reporting", db)) throw new OperationError("This market is unavailable to your account.");
  return db.intelligenceDraft.findMany({ where: { marketId, test }, orderBy: { createdAt: "desc" }, take: 40,
    include: { observations: { orderBy: { createdAt: "desc" }, take: 8 } } });
}
