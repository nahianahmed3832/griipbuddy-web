import { randomInt } from "node:crypto";
import { z } from "zod";
import { getDb } from "../db/client.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { equalDigest, requestDigest } from "../commerce/guest.ts";
import { sendShopperMail, shopperMailSupports } from "../commerce/shopper-mail.ts";
import { accountText, type AccountLanguage } from "./account-language.ts";
import { legacyKind, linkLegacyCustomer, matchLegacyRecovery, type LegacyKind } from "./bd-order-hub-bridge.ts";

const maxAttempts = 5;
const validity = 10 * 60_000;
const referenceInput = z.string().trim().regex(/^#?[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/)
  .transform(value => value.replace(/^#/, "").toUpperCase());
const emailInput = z.string().trim().toLowerCase().pipe(z.email().max(254));
const orderInput = { kind: legacyKind, reference: referenceInput };
export const bdOrderCommand = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("link"), phone: z.string().trim().min(10).max(24), password: z.string().min(1).max(128) }),
  z.strictObject({ action: z.literal("start"), ...orderInput, email: emailInput }),
  z.strictObject({ action: z.literal("confirm"), ...orderInput, email: emailInput, challenge: z.uuid(), code: z.string().regex(/^\d{6}$/) }),
  z.strictObject({ action: z.literal("verified-phone"), ...orderInput }),
]);

type OrderInput = { kind: LegacyKind; reference: string };
type EmailInput = OrderInput & { email: string };
type RecoveryTarget = { target: "native" | LegacyKind; sourceId: string };

function digest(parts: string[]) {
  return requestDigest(JSON.stringify(["bd-order-hub", ...parts]));
}

async function targetForEmail({ kind, reference, email }: EmailInput): Promise<RecoveryTarget | null> {
  if (kind === "order" && /^GB-[A-F0-9]{12}$/.test(reference)) {
    const order = await getDb().order.findFirst({
      where: { marketId: "bd", reference, shopperId: null, email: { equals: email, mode: "insensitive" } },
      select: { id: true },
    });
    if (order) return { target: "native", sourceId: order.id };
  }
  const id = await matchLegacyRecovery(kind, reference, "email", email);
  return id ? { target: kind, sourceId: id } : null;
}

async function addLegacyGrant(tx: Prisma.TransactionClient, shopperId: string, kind: LegacyKind, sourceId: string) {
  await tx.bangladeshOrderGrant.createMany({ data: { shopperId, kind, sourceId }, skipDuplicates: true });
  const grant = await tx.bangladeshOrderGrant.findUnique({ where: { kind_sourceId: { kind, sourceId } }, select: { shopperId: true } });
  return grant?.shopperId === shopperId;
}

export async function bdLegacyAccess(shopperId: string) {
  const db = getDb();
  const [linked, grants] = await Promise.all([
    db.bangladeshLegacyAccount.findUnique({ where: { shopperId }, select: { customerId: true } }),
    db.bangladeshOrderGrant.findMany({ where: { shopperId }, select: { kind: true, sourceId: true }, take: 500,
      orderBy: { claimedAt: "desc" } }),
  ]);
  return { legacyCustomerId: linked?.customerId ?? null,
    grants: grants.map(grant => ({ kind: legacyKind.parse(grant.kind), id: grant.sourceId })) };
}

export async function saveLegacyAccount(shopperId: string, phone: string, password: string) {
  const { legacyCustomerId } = await linkLegacyCustomer(phone, password);
  const db = getDb();
  await db.bangladeshLegacyAccount.createMany({ data: { shopperId, customerId: legacyCustomerId }, skipDuplicates: true });
  const linked = await db.bangladeshLegacyAccount.findUnique({ where: { shopperId }, select: { customerId: true } });
  return linked?.customerId === legacyCustomerId;
}

export async function startBangladeshRecovery(id: string, shopperId: string, input: EmailInput, language: AccountLanguage) {
  const now = new Date();
  const code = randomInt(1_000_000).toString().padStart(6, "0");
  const found = shopperMailSupports(input.email) ? await targetForEmail(input) : null;
  const db = getDb();
  await db.bangladeshOrderChallenge.deleteMany({ where: { expiresAt: { lt: new Date(now.getTime() - validity) } } });
  await db.bangladeshOrderChallenge.create({ data: { id, shopperId, ...found,
    codeDigest: digest([id, shopperId, code]), inputDigest: digest([input.kind, input.reference, input.email]),
    expiresAt: new Date(now.getTime() + validity) } });
  if (found) {
    await sendShopperMail({
      kind: "order-recovery", to: input.email,
      subject: accountText(language, "Your GriipBuddy order recovery code", "আপনার GriipBuddy অর্ডার পুনরুদ্ধার কোড"),
      text: `${accountText(language, "Recovery code", "পুনরুদ্ধার কোড")}: ${code}\n\n${accountText(language,
        "This code expires in 10 minutes. Enter it in My Orders on the device that requested it.",
        "কোডটি ১০ মিনিটের মধ্যে ব্যবহার করুন। যে ডিভাইস থেকে অনুরোধ করেছেন, সেখানে আমার অর্ডারে কোডটি লিখুন।")}`,
    });
  }
}

export async function confirmBangladeshRecovery(shopperId: string, input: EmailInput & { challenge: string; code: string }) {
  const db = getDb();
  const challenge = await db.bangladeshOrderChallenge.findFirst({ where: {
    id: input.challenge, shopperId, expiresAt: { gt: new Date() }, attempts: { lt: maxAttempts }, consumedAt: null,
  } });
  if (!challenge) return false;
  const inputMatches = equalDigest(challenge.inputDigest, digest([input.kind, input.reference, input.email]));
  const codeMatches = equalDigest(challenge.codeDigest, digest([input.challenge, shopperId, input.code]));
  if (!inputMatches || !codeMatches || !challenge.sourceId || !challenge.target) {
    await db.bangladeshOrderChallenge.updateMany({ where: { id: challenge.id, shopperId, consumedAt: null,
      attempts: { lt: maxAttempts } }, data: { attempts: { increment: 1 } } });
    return false;
  }
  const target = await targetForEmail(input);
  if (!target || target.sourceId !== challenge.sourceId || target.target !== challenge.target) return false;
  return db.$transaction(async tx => {
    const consumed = await tx.bangladeshOrderChallenge.updateMany({ where: {
      id: challenge.id, shopperId, expiresAt: { gt: new Date() }, attempts: { lt: maxAttempts }, consumedAt: null,
    }, data: { consumedAt: new Date() } });
    if (!consumed.count) return false;
    if (target.target !== "native") return addLegacyGrant(tx, shopperId, target.target, target.sourceId);
    const claimed = await tx.order.updateMany({ where: {
      id: target.sourceId, marketId: "bd", shopperId: null, email: { equals: input.email, mode: "insensitive" },
    }, data: { shopperId } });
    if (!claimed.count) return false;
    await tx.shopperAccountEvent.create({ data: { shopperId, marketId: "bd", action: "order_claimed" } });
    return true;
  });
}

export async function recoverWithVerifiedPhone(shopperId: string, input: OrderInput) {
  const db = getDb();
  const shopper = await db.shopper.findUnique({ where: { id: shopperId },
    select: { phoneNumber: true, phoneNumberVerified: true } });
  const phone = shopper?.phoneNumber;
  if (!shopper?.phoneNumberVerified || !phone || !/^\+8801[3-9]\d{8}$/.test(phone) || phone === "+8801700000000") return false;
  const id = await matchLegacyRecovery(input.kind, input.reference, "sms", phone);
  return id ? db.$transaction(tx => addLegacyGrant(tx, shopperId, input.kind, id)) : false;
}
