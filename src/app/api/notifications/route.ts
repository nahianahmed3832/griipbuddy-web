import { z } from "zod";
import { marketIdInput } from "@/lib/market-config";
import { marketplaceMode } from "@/lib/release-config";
import { currentMarket } from "@/lib/market-server";
import { getShopperFromHeaders } from "@/lib/marketplace/auth";
import { getStaffFromHeaders } from "@/lib/staff/access";
import { privateHeaders, readJson, sameOrigin } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { NotificationError, markNotification, setOrderNotifications } from "@/lib/notifications/inbox";
import { queueTestNewsletter, retryTestDelivery } from "@/lib/notifications/test-delivery";

const actionInput = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("mark"), audience: z.enum(["customer", "seller", "staff"]), marketId: marketIdInput,
    key: z.string().max(80), dismiss: z.boolean(), shopId: z.uuid().optional() }),
  z.strictObject({ action: z.literal("order-policy"), marketId: marketIdInput, placed: z.boolean(), fulfillment: z.boolean() }),
  z.strictObject({ action: z.literal("queue-test"), marketId: marketIdInput, operationId: z.uuid(),
    subject: z.string().max(120), body: z.string().max(1000) }),
  z.strictObject({ action: z.literal("retry-test"), marketId: marketIdInput, id: z.uuid() }),
]);

function reply(status: number, message: string) {
  return Response.json({ message }, { status, headers: privateHeaders });
}

export async function POST(request: Request) {
  if (!marketplaceMode()) return reply(404, "Notifications are unavailable.");
  if (!sameOrigin(request)) return reply(403, "Open this action from the storefront.");
  const parsed = actionInput.safeParse(await readJson(request, 4096));
  if (!parsed.success) return reply(422, "Check the notification fields.");
  const input = parsed.data;
  try {
    const staffSide = input.action !== "mark" || input.audience === "staff";
    const actor = staffSide ? await getStaffFromHeaders(request.headers) : await getShopperFromHeaders(request.headers);
    if (!actor) return reply(401, "Sign in to continue.");
    if (!staffSide && (await currentMarket()).id !== input.marketId) return reply(404, "This inbox is unavailable.");
    if (!await consumeQuota(`notification.${staffSide ? "staff" : "shopper"}`, actor.id, 45, 60)) {
      return reply(429, "Too many changes. Try again shortly.");
    }
    switch (input.action) {
      case "mark":
        await markNotification({ audience: input.audience, actorId: actor.id, marketId: input.marketId, shopId: input.shopId }, input.key, input.dismiss);
        return reply(200, input.dismiss ? "Notification dismissed." : "Marked as read.");
      case "order-policy":
        await setOrderNotifications(actor.id, input.marketId, { placed: input.placed, fulfillment: input.fulfillment });
        return reply(200, "Order alert settings saved.");
      case "queue-test":
        await queueTestNewsletter(actor.id, input.marketId, input);
        return reply(200, "Synthetic newsletter queued.");
      case "retry-test":
        await retryTestDelivery(actor.id, input.marketId, input.id);
        return reply(200, "Test retry queued.");
    }
  } catch (error) {
    if (error instanceof NotificationError) return reply(error.status, error.message);
    reportFailure("notifications.write", undefined, error);
    return reply(503, "The change could not be saved. Try again.");
  }
}
