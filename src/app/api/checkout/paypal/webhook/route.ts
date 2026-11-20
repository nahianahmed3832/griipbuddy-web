import { z } from "zod";
import { reconcilePayPalCapture, reconcilePayPalPurchaseRefund } from "@/lib/commerce/paypal-checkout";
import { paypalSandboxConfig } from "@/lib/commerce/paypal-config";
import { samePayPalAmount, verifySandboxWebhook } from "@/lib/commerce/paypal-provider";
import { reconcilePayPalRefund } from "@/lib/commerce/paypal-refund";
import { finishPaymentEvent, paymentEventDigest, PaymentEventConflict, recordPaymentEvent } from "@/lib/commerce/provider-payment-events";
import { paypalCaseRefundTarget, reconcilePayPalOrderCaseRefund } from "@/lib/marketplace/case-refunds";
import { getDb } from "@/lib/db/client";
import { privateHeaders, readJson } from "@/lib/db/http";
import { reportFailure } from "@/lib/db/observability";

const identifier = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/);
const amount = z.object({ currency_code: z.string(), value: z.string() });
const captureEvent = z.object({
  id: identifier,
  event_type: z.enum(["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"]),
  resource: z.object({
    id: identifier,
    amount: amount.optional(),
    supplementary_data: z.object({ related_ids: z.object({ order_id: identifier }) }),
  }),
});
const refundEvent = z.object({
  id: identifier,
  event_type: z.enum(["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.REFUND.COMPLETED", "PAYMENT.REFUND.PENDING", "PAYMENT.REFUND.FAILED"]),
  resource: z.object({ id: identifier, amount: amount.optional(), custom_id: z.string().max(80).optional() }),
});
const result = (status: number) => new Response(null, { status, headers: privateHeaders });

export async function POST(request: Request) {
  const config = paypalSandboxConfig();
  if (!config?.clientId || !config.clientSecret || !config.webhookId || !config.accountKey) return result(404);
  const event = await readJson(request, 65_536);
  if (!event || typeof event !== "object" || Array.isArray(event)) return result(400);
  try {
    if (!await verifySandboxWebhook(event, request.headers)) return result(403);
    const capture = captureEvent.safeParse(event).data;
    const refund = refundEvent.safeParse(event).data;
    const envelope = capture ?? refund;
    if (!envelope) return result(204);
    const db = getDb();
    const { id, event_type, resource } = envelope;
    const orderId = capture?.resource.supplementary_data.related_ids.order_id;
    const caseRefund = refund && await paypalCaseRefundTarget(refund.resource.id, refund.resource.custom_id);
    const session = caseRefund ? { attemptId: caseRefund.attemptId, providerAccountKey: caseRefund.accountKey,
      expectedAmountMinor: caseRefund.amountMinor } : await db.payPalCheckout.findFirst({
      where: { ...(orderId ? { providerOrderId: orderId } : { refundId: resource.id }), attempt: { marketId: config.marketId } },
      select: { attemptId: true, providerAccountKey: true, expectedAmountMinor: true },
    });
    const amountMismatch = resource.amount !== undefined && session?.expectedAmountMinor != null &&
      !samePayPalAmount(resource.amount, session.expectedAmountMinor);
    const rejected = session && (session.providerAccountKey !== config.accountKey || amountMismatch ||
      caseRefund && caseRefund.marketId !== config.marketId);
    const evidence = await recordPaymentEvent(db, {
      provider: "PAYPAL", accountKey: config.accountKey, eventKey: `webhook:${id}`, marketId: config.marketId,
      attemptId: session?.providerAccountKey === config.accountKey ? session.attemptId : undefined, eventType: event_type, providerReference: resource.id,
      evidenceHash: paymentEventDigest([event_type, resource.id, orderId, resource.amount?.currency_code, resource.amount?.value]),
    });
    if (evidence.processedAt) return result(evidence.outcome === "REJECTED" ? 422 : 204);
    if (rejected) {
      await finishPaymentEvent(db, evidence, "REJECTED");
      return result(422);
    }
    if (capture && orderId) {
      const outcome = await reconcilePayPalCapture(orderId, config.accountKey, resource.id, event_type === "PAYMENT.CAPTURE.COMPLETED");
      if (outcome === null) return result(503);
      await finishPaymentEvent(db, evidence, outcome);
    } else if (refund && session) {
      if (caseRefund) {
        const reconciled = await reconcilePayPalOrderCaseRefund(caseRefund.caseId, resource.id);
        // PayPal can deliver the terminal event before the authenticated lookup reflects it.
        if (reconciled.state === "PROCESSING" && event_type !== "PAYMENT.REFUND.PENDING") return result(503);
      } else {
        await reconcilePayPalRefund(resource.id);
        await reconcilePayPalPurchaseRefund(resource.id);
      }
      await finishPaymentEvent(db, evidence, "PROCESSED");
    } else await finishPaymentEvent(db, evidence, "IGNORED");
    return result(204);
  } catch (error) {
    if (error instanceof PaymentEventConflict) return result(409);
    reportFailure("paypal.webhook", undefined, error);
    return result(503);
  }
}
