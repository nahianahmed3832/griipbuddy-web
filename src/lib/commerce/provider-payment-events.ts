import { createHash } from "node:crypto";
import type { Prisma } from "../../generated/prisma/client.ts";

export type PaymentEventOutcome = "IGNORED" | "REJECTED" | "FAILED" | "CLOSED" | "PAID" | "PAYMENT_EXCEPTION" | "PROCESSED";

export const paymentEventDigest = (evidence: unknown) => createHash("sha256").update(JSON.stringify(evidence)).digest("hex");

export class PaymentEventConflict extends Error {
  constructor() { super("Verified payment event conflicts with its original identity."); }
}

export async function recordPaymentEvent(db: Prisma.TransactionClient, event: Prisma.ProviderPaymentEventUncheckedCreateInput) {
  const key = { provider: event.provider, accountKey: event.accountKey, eventKey: event.eventKey };
  await db.providerPaymentEvent.createMany({ data: [event], skipDuplicates: true });
  const existing = await db.providerPaymentEvent.findUniqueOrThrow({ where: { provider_accountKey_eventKey: key } });
  if (existing.evidenceHash !== event.evidenceHash || existing.providerReference !== event.providerReference) throw new PaymentEventConflict();
  return existing;
}

export async function finishPaymentEvent(db: Prisma.TransactionClient,
  key: Pick<Prisma.ProviderPaymentEventUncheckedCreateInput, "provider" | "accountKey" | "eventKey">, outcome: PaymentEventOutcome) {
  await db.providerPaymentEvent.updateMany({ where: { provider: key.provider, accountKey: key.accountKey, eventKey: key.eventKey, processedAt: null }, data: { outcome, processedAt: new Date() } });
}
