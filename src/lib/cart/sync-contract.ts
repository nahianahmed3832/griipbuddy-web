import { z } from "zod";
import { personalizationText } from "../catalog/personalization.ts";
import { MAX_CART_LINES, MAX_QUANTITY, validCartOfferId, validVariantId, type CartItem } from "./model.ts";

const product = {
  variantId: z.string().refine(validVariantId),
  offerId: z.string().refine(validCartOfferId).optional(),
  personalization: z.string().trim().refine(value => Boolean(personalizationText(value))).optional(),
};
const quantity = z.int().min(1).max(MAX_QUANTITY);
const expectedQuantity = quantity.optional();
const sourceLine = { ...product, expectedQuantity };
const lines = z.array(z.strictObject({ ...product, quantity })).max(MAX_CART_LINES);
const action = z.literal("cart-sync");
const shopperId = z.string().min(1).max(256);

const cartChange = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("add"), ...product, quantity }),
  z.strictObject({ type: z.literal("set"), ...product, quantity, expectedQuantity: quantity }),
  z.strictObject({ type: z.literal("remove"), ...sourceLine }),
  z.strictObject({ type: z.literal("move-to-saved"), ...sourceLine }),
  z.strictObject({ type: z.literal("restore-saved"), ...sourceLine }),
  z.strictObject({ type: z.literal("remove-saved"), ...sourceLine }),
  z.strictObject({ type: z.literal("complete-purchase"), orderId: z.uuid() }),
]);

export const cartSyncRequest = z.discriminatedUnion("mode", [
  z.strictObject({ action, shopperId, mode: z.literal("read") }),
  z.strictObject({ action, shopperId, mode: z.literal("merge"), operationId: z.uuid(), items: lines, saved: lines }),
  z.strictObject({ action, shopperId, mode: z.literal("change"), operationId: z.uuid(), command: cartChange }),
]);

export type CartChange = z.infer<typeof cartChange>;
export type CartSyncRequest = z.infer<typeof cartSyncRequest>;
export type CartSyncSnapshot = { shopperId: string; revision: number; items: readonly CartItem[]; saved: readonly CartItem[] };
