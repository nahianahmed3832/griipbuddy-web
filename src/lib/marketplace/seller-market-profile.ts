import { createHash } from "node:crypto";
import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { getDb } from "../db/client.ts";
import { localDatabase } from "../db/local.ts";
import { marketConfiguration } from "../market-config.ts";
import { resolveSellerAccess, getSellerAccess, lockSellerScope } from "./seller-access.ts";

const field = z.enum(["businessName", "website", "summary"]);
export const sellerVerificationLabels = { businessName: "Business name", website: "Public website", summary: "What your business sells" } as const;
const text = (max: number) => z.string().trim().min(1).max(max);
const key = z.uuid();
const revision = z.int().min(0);
const sellerActions = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("profile.save"), key, shopId: key, revision, presentation: z.enum(["classic", "compact"]),
    about: z.string().trim().max(1600), announcement: z.string().trim().max(200), locale: text(35) }),
  z.strictObject({ action: z.literal("address.save"), key, shopId: key, id: key.optional(), revision,
    purpose: z.enum(["business", "returns"]), line: text(180), city: text(90), region: text(90), postal: z.string().trim().max(20) }),
  z.strictObject({ action: z.literal("address.archive"), key, shopId: key, id: key, revision }),
  z.strictObject({ action: z.literal("verification.submit"), key, shopId: key, version: z.int().positive(),
    answers: z.partialRecord(field, text(400)) }),
]);
const staffActions = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("verification.form"), key, previousVersion: revision, fields: z.array(field).min(1).max(3)
    .refine(values => new Set(values).size === values.length, "Choose each field once.") }),
  z.strictObject({ action: z.literal("verification.review"), key, id: key, decision: z.enum(["ACCEPTED", "DECLINED"]), note: text(400) }),
]);

export class SellerProfileError extends Error {
  constructor(message: string, readonly status = 422) { super(message); }
}
const missing = () => new SellerProfileError("This shop or record is unavailable in the selected market.", 404);
const changed = () => new SellerProfileError("This record changed. Reload and review the current version.", 409);

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const value = schema.safeParse(input);
  if (!value.success) throw new SellerProfileError(value.error.issues[0]?.message ?? "Review the required fields.");
  return value.data;
}

export function sellerVerificationTestMode() {
  return process.env.GRIIP_SELLER_VERIFICATION_TEST === "1" && localDatabase() === "griipbuddy_test";
}

function requireVerificationTest() {
  if (!sellerVerificationTestMode()) throw new SellerProfileError("Business verification is unavailable in this environment.", 403);
}

function fieldList(input: unknown) {
  return z.array(field).parse(input);
}

async function requireOwner(db: Prisma.TransactionClient, actor: string, lock = false) {
  if (lock) await db.$queryRaw`SELECT "userId" FROM "StaffAccess" WHERE "userId" = ${actor} FOR SHARE`;
  const staff = await db.staffAccess.findFirst({ where: { userId: actor, role: "OWNER", active: true }, select: { userId: true } });
  if (!staff) throw new SellerProfileError("Owner access is required.", 403);
}

async function lock(db: Prisma.TransactionClient, scope: string) {
  await db.$queryRaw`SELECT true FROM pg_advisory_xact_lock(hashtextextended(${scope}, 0))`;
}

type Operation = { key: string; action: string };
type AuditScope = { shopId: string | null; marketId: MarketId; actorId: string; actorKind: "seller" | "staff" };

async function saveOperation(db: Prisma.TransactionClient, scope: AuditScope, input: Operation, apply: () => Promise<string>) {
  await lock(db, "seller-profile-command:" + input.key);
  const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
  const prior = await db.sellerProfileAudit.findUnique({ where: { id: input.key } });
  if (prior) {
    if (prior.marketId !== scope.marketId || prior.shopId !== scope.shopId || prior.actorKind !== scope.actorKind ||
        prior.actorId !== scope.actorId || prior.fingerprint !== fingerprint) throw changed();
    return { saved: true, id: prior.target, replayed: true };
  }
  const target = await apply();
  await db.sellerProfileAudit.create({ data: { ...scope, id: input.key, action: input.action, target, fingerprint } });
  return { saved: true, id: target, replayed: false };
}

function latestForm(db: Prisma.TransactionClient, marketId: MarketId) {
  return db.sellerVerificationForm.findFirst({ where: { marketId }, orderBy: { version: "desc" } });
}

export async function sellerMarketProfile(shopperId: string, marketId: MarketId, shopId?: string) {
  const access = await resolveSellerAccess(shopperId, marketId, "PROFILE", shopId);
  if (!access) return null;
  const scope = { shopId: access.shop.id, marketId };
  const verification = sellerVerificationTestMode();
  const db = getDb();
  const [profile, addresses, form, submission, baseline] = await Promise.all([
    db.sellerMarketProfile.findUnique({ where: { shopId_marketId: scope } }),
    db.sellerBusinessAddress.findMany({ where: { ...scope, archived: false },
      orderBy: [{ purpose: "asc" }, { id: "asc" }], take: 30 }),
    verification ? latestForm(db, marketId) : null,
    verification ? db.sellerVerificationSubmission.findFirst({
      where: scope, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { version: true, state: true, note: true },
    }) : null,
    db.marketplaceShop.findUnique({ where: { id: access.shop.id }, select: { about: true, announcement: true } }),
  ]);
  return { shop: access.shop, profile, baseline, addresses, form: form && { version: form.version, fields: fieldList(form.fields) }, submission, verification };
}

export async function saveSellerMarketProfile(shopperId: string, marketId: MarketId, raw: unknown) {
  const input = parse(sellerActions, raw);
  return getDb().$transaction(async db => {
    const { shopId } = input;
    await lockSellerScope(db, shopId, marketId);
    if (!await getSellerAccess(shopperId, shopId, marketId, "PROFILE", db)) throw missing();
    const scope = { shopId, marketId };
    return saveOperation(db, { ...scope, actorId: shopperId, actorKind: "seller" }, input, async () => {
      await lock(db, ["seller-profile", shopId, marketId].join(":"));
      if (input.action === "profile.save") {
        if (!marketConfiguration(marketId).languages.includes(input.locale)) throw new SellerProfileError("Choose a language supported in this market.");
        const unique = { shopId_marketId: scope };
        const old = await db.sellerMarketProfile.findUnique({ where: unique, select: { revision: true } });
        if ((old?.revision ?? 0) !== input.revision) throw changed();
        const data = { about: input.about, announcement: input.announcement, locale: input.locale, presentation: input.presentation,
          revision: input.revision + 1 };
        await db.sellerMarketProfile.upsert({ where: unique, create: { ...scope, ...data }, update: data });
        return shopId;
      }
      if (input.action === "verification.submit") {
        requireVerificationTest();
        await lock(db, "seller-verification-form:" + marketId);
        const form = await latestForm(db, marketId);
        if (!form || form.version !== input.version) throw changed();
        const fields = fieldList(form.fields);
        if (Object.keys(input.answers).length !== fields.length || fields.some(name => !input.answers[name])) {
          throw new SellerProfileError("Complete the fields in the current review form.");
        }
        const website = input.answers.website;
        if (website) {
          const parsed = z.url({ protocol: /^https$/ }).safeParse(website);
          if (!parsed.success || new URL(website).username || new URL(website).password) {
            throw new SellerProfileError("Enter an HTTPS business website without credentials.");
          }
        }
        if (await db.sellerVerificationSubmission.findFirst({ where: { ...scope, state: "SUBMITTED" }, select: { id: true } })) {
          throw new SellerProfileError("Your previous submission is still awaiting review.", 409);
        }
        await db.sellerVerificationSubmission.create({ data: { ...scope, id: input.key,
          version: input.version, answers: input.answers, actorId: shopperId, state: "SUBMITTED" } });
        return input.key;
      }
      if (input.action === "address.archive") {
        const old = await db.sellerBusinessAddress.findFirst({ where: { ...scope, id: input.id, archived: false } });
        if (!old) throw missing();
        if (old.revision !== input.revision) throw changed();
        await db.sellerBusinessAddress.update({ where: { id: input.id }, data: { archived: true, revision: { increment: 1 } } });
        return input.id;
      }
      const { id, purpose, line, city, region, postal } = input;
      const data = { purpose, line, city, region, postal, revision: input.revision + 1 };
      if (id) {
        const old = await db.sellerBusinessAddress.findFirst({ where: { ...scope, id, archived: false } });
        if (!old) throw missing();
        if (old.revision !== input.revision) throw changed();
        await db.sellerBusinessAddress.update({ where: { id }, data });
        return id;
      }
      if (input.revision !== 0) throw changed();
      if (await db.sellerBusinessAddress.count({ where: { ...scope, archived: false } }) >= 30) {
        throw new SellerProfileError("Archive an existing address before adding another.", 409);
      }
      return (await db.sellerBusinessAddress.create({ data: { ...scope, ...data, id: input.key }, select: { id: true } })).id;
    });
  });
}

export async function sellerVerificationQueue(actorId: string, marketId: MarketId, page = 1) {
  requireVerificationTest();
  return getDb().$transaction(async db => {
    await requireOwner(db, actorId);
    const [form, rows] = await Promise.all([
      latestForm(db, marketId),
      db.sellerVerificationSubmission.findMany({ where: { marketId },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * 20, take: 21,
        select: { id: true, version: true, state: true, note: true, answers: true, createdAt: true, grant: { select: {
          shop: { select: { name: true } },
        } } } }),
    ]);
    return { form: form && { version: form.version, fields: fieldList(form.fields) }, rows: rows.slice(0, 20), hasNext: rows.length > 20 };
  });
}

export async function saveSellerVerification(actorId: string, marketId: MarketId, raw: unknown) {
  requireVerificationTest();
  const input = parse(staffActions, raw);
  return getDb().$transaction(async db => {
    await requireOwner(db, actorId, true);
    return saveOperation(db, { shopId: null, marketId, actorId, actorKind: "staff" }, input, async () => {
      if (input.action === "verification.form") {
        await lock(db, "seller-verification-form:" + marketId);
        const current = await latestForm(db, marketId);
        if ((current?.version ?? 0) !== input.previousVersion) throw changed();
        const version = input.previousVersion + 1;
        await db.sellerVerificationForm.create({ data: { marketId, version, actorId, fields: input.fields } });
        return String(version);
      }
      const updated = await db.sellerVerificationSubmission.updateMany({
        where: { id: input.id, marketId, state: "SUBMITTED" },
        data: { state: input.decision, note: input.note, reviewedBy: actorId, reviewedAt: new Date() },
      });
      if (updated.count !== 1) throw new SellerProfileError("This submission is unavailable or was already reviewed.", 409);
      return input.id;
    });
  });
}
