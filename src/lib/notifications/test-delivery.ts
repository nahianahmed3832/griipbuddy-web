import { createHash } from "node:crypto";
import type { MarketId } from "../../config/markets.ts";
import type { NotificationTestState } from "../../generated/prisma/enums.ts";
import type { DbReader } from "../db/client.ts";
import { getDb } from "../db/client.ts";
import { developmentAcceptanceDatabase, localDatabase } from "../db/local.ts";
import { isMarketSelectable, marketConfiguration } from "../market-config.ts";
import { authorizeNotifications, NotificationError } from "./inbox.ts";

type Draft = { operationId: string; subject: string; body: string };
type TestResult = "accept" | "temporary-failure";
type JobAttempt = { deliveryId: string; marketId: MarketId; locale: string; subject: string; body: string; attempt: number };
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const delays = [60_000, 300_000] as const;
const maximumAttempts = 6;
const automaticAttempts = 3;

export function notificationSandbox() {
  return process.env.GRIIP_NOTIFICATION_TEST_MODE === "1" &&
    (localDatabase() === "griipbuddy_test" || developmentAcceptanceDatabase());
}

function fixtureAddress(market: MarketId) {
  const email = process.env[`GRIIP_NOTIFICATION_TEST_EMAIL_${market.toUpperCase()}`]?.trim().toLowerCase();
  return notificationSandbox() && email && /^[a-z0-9][a-z0-9+._-]{0,62}@example\.invalid$/.test(email) ? email : undefined;
}

async function recipient(db: DbReader, marketId: MarketId, lock = false) {
  const email = fixtureAddress(marketId);
  if (!email || !isMarketSelectable(marketId)) return null;
  const user = lock ? (await db.$queryRaw<{ locale: string }[]>`
    SELECT locale FROM "NewsletterRequest" WHERE "marketId" = ${marketId}::"MarketCode" AND email = ${email} FOR SHARE
  `)[0] : await db.newsletterRequest.findUnique({
    where: { marketId_email: { marketId, email } }, select: { locale: true },
  });
  return user && marketConfiguration(marketId).languages.includes(user.locale)
    ? { locale: user.locale, hash: fingerprint(email) } : null;
}

async function requireOwner(db: DbReader, actorId: string) {
  const staff = await db.staffAccess.findUnique({ where: { userId: actorId }, select: { role: true, active: true } });
  if (staff?.role !== "OWNER" || !staff.active) throw new NotificationError("Owner access is required.", 403);
}

export async function testDeliveryStatus(actorId: string, marketId: MarketId) {
  const db = getDb();
  await requireOwner(db, actorId);
  if (!notificationSandbox() || !isMarketSelectable(marketId)) return { ready: false, subscribed: false, jobs: [] };
  const [validRecipient, jobs] = await Promise.all([
    recipient(db, marketId),
    db.notificationTestJob.findMany({
      where: { marketId }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 25,
      select: { id: true, locale: true, state: true, attemptCount: true, nextAt: true, createdAt: true,
        attempts: { orderBy: { number: "desc" }, take: 1, select: { reason: true } } },
    }),
  ]);
  return { ready: Boolean(fixtureAddress(marketId)), subscribed: Boolean(validRecipient), jobs };
}

export async function queueTestNewsletter(actorId: string, marketId: MarketId, draft: Draft, now = new Date()) {
  if (!notificationSandbox()) throw new NotificationError("The local test sink is unavailable.", 404);
  const subject = draft.subject.trim();
  const body = draft.body.trim();
  if (!subject || subject.length > 120 || /[\x00-\x1f\x7f]/u.test(subject) || !body || body.length > 1000 ||
      /[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/u.test(body) ||
      !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(draft.operationId)) {
    throw new NotificationError("Check the subject, message and operation ID.", 422);
  }
  return getDb().$transaction(async db => {
    await authorizeNotifications(db, actorId, marketId, true);
    const allowed = await recipient(db, marketId, true);
    if (!allowed) throw new NotificationError("A scoped synthetic opt-in is required.", 409);
    const key = { marketId, operationId: draft.operationId };
    const requestHash = fingerprint([actorId, marketId, allowed.locale, allowed.hash, subject, body]);
    await db.notificationTestJob.createMany({ data: { ...key, actorId, requestHash, locale: allowed.locale, subject,
      body, recipientHash: allowed.hash, nextAt: now, createdAt: now }, skipDuplicates: true });
    const job = await db.notificationTestJob.findUniqueOrThrow({
      where: { marketId_operationId: key }, select: { id: true, requestHash: true },
    });
    if (job.requestHash !== requestHash) throw new NotificationError("This operation ID already belongs to another draft.", 409);
    return { id: job.id };
  });
}

export async function retryTestDelivery(actorId: string, marketId: MarketId, jobId: string, now = new Date()) {
  if (!notificationSandbox()) throw new NotificationError("The local test sink is unavailable.", 404);
  return getDb().$transaction(async db => {
    await authorizeNotifications(db, actorId, marketId, true);
    const allowed = await recipient(db, marketId, true);
    if (!allowed) throw new NotificationError("A scoped synthetic opt-in is required.", 409);
    const updated = await db.notificationTestJob.updateMany({
      where: { id: jobId, marketId, recipientHash: allowed.hash, locale: allowed.locale, state: "FAILED",
        attemptCount: { lt: maximumAttempts } },
      data: { state: "QUEUED", nextAt: now },
    });
    if (!updated.count) throw new NotificationError("This delivery cannot be retried.", 409);
  });
}

export async function runNotificationTestJob(now = new Date(), simulate?: (attempt: JobAttempt) => TestResult) {
  if (!notificationSandbox()) return null;
  return getDb().$transaction(async db => {
    const [selected] = await db.$queryRaw<{ id: string }[]>`
      SELECT id FROM "NotificationTestJob"
      WHERE state IN ('QUEUED', 'RETRY_PENDING') AND "nextAt" <= ${now} AND "attemptCount" < ${maximumAttempts}
      ORDER BY "nextAt", id LIMIT 1 FOR UPDATE SKIP LOCKED
    `;
    if (!selected) return null;
    const job = await db.notificationTestJob.findUniqueOrThrow({ where: { id: selected.id } });
    const allowed = await recipient(db, job.marketId, true);
    const number = job.attemptCount + 1;
    const input = { deliveryId: job.id, marketId: job.marketId, locale: job.locale, subject: job.subject, body: job.body, attempt: number };
    let state: NotificationTestState = "FAILED";
    let reason: string | undefined;
    let nextAt = now;
    if (!allowed || allowed.hash !== job.recipientHash || allowed.locale !== job.locale) {
      reason = "OPT_IN_OR_CONFIGURATION_CHANGED";
    } else {
      let result: TestResult = "accept";
      try { if (simulate) result = simulate(input); }
      catch { result = "temporary-failure"; }
      if (result === "accept") {
        await db.notificationTestSink.create({ data: { jobId: job.id, marketId: job.marketId,
          recipientHash: allowed.hash, payloadHash: fingerprint([job.locale, job.subject, job.body]), acceptedAt: now } });
        state = "SINK_ACCEPTED";
      } else {
        reason = "TEMPORARY_TEST_SINK_FAILURE";
        if (number % automaticAttempts !== 0 && number < maximumAttempts) {
          state = "RETRY_PENDING";
          nextAt = new Date(now.valueOf() + delays[(number - 1) % automaticAttempts]);
        }
      }
    }
    await db.notificationTestAttempt.create({ data: { jobId: job.id, number, outcome: state, reason, attemptedAt: now } });
    await db.notificationTestJob.update({ where: { id: job.id }, data: { attemptCount: number, state, nextAt } });
    return { jobId: job.id, state };
  });
}
