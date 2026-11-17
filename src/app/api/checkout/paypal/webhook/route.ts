import { z } from "zod";
import { reconcilePayPalCapture } from "@/lib/commerce/paypal-checkout";
import { paypalSandboxConfig } from "@/lib/commerce/paypal-config";
import { verifySandboxWebhook } from "@/lib/commerce/paypal-provider";
import { reconcilePayPalRefund } from "@/lib/commerce/paypal-refund";
import { privateHeaders, readJson } from "@/lib/db/http";
import { reportFailure } from "@/lib/db/observability";

const captureEvent = z.object({
  event_type: z.enum(["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.PENDING", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.DECLINED"]),
  resource: z.object({ supplementary_data: z.object({ related_ids: z.object({ order_id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }) }) }),
});
const refundEvent = z.object({
  event_type: z.enum(["PAYMENT.CAPTURE.REFUNDED", "PAYMENT.REFUND.COMPLETED", "PAYMENT.REFUND.PENDING", "PAYMENT.REFUND.FAILED"]),
  resource: z.object({ id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }),
});

export async function POST(request: Request) {
  const config = paypalSandboxConfig();
  if (!config?.clientId || !config.clientSecret || !config.webhookId) return new Response(null, { status: 404, headers: privateHeaders });
  const event = await readJson(request, 65_536);
  if (!event || typeof event !== "object" || Array.isArray(event)) return new Response(null, { status: 400, headers: privateHeaders });
  try {
    if (!await verifySandboxWebhook(event, request.headers)) return new Response(null, { status: 403, headers: privateHeaders });
    const capture = captureEvent.safeParse(event);
    if (capture.success) await reconcilePayPalCapture(capture.data.resource.supplementary_data.related_ids.order_id);
    const refund = refundEvent.safeParse(event);
    if (refund.success) await reconcilePayPalRefund(refund.data.resource.id);
    return new Response(null, { status: 204, headers: privateHeaders });
  } catch (error) {
    reportFailure("paypal.webhook", undefined, error);
    return new Response(null, { status: 503, headers: privateHeaders });
  }
}
