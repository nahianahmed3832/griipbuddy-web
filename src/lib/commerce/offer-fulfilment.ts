import { z } from "zod";
import { MAX_QUANTITY, validVariantId } from "../cart/model.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { marketIdInput } from "../market-config.ts";
import { readConnectedOffer } from "./market-offers.ts";
import { eligibleInventoryPools, inventoryDestinationInput } from "./physical-inventory.ts";

const fulfilmentInput = z.strictObject({
  variantId: z.string().refine(validVariantId),
  marketId: marketIdInput,
  delivery: z.strictObject({
    destination: inventoryDestinationInput,
    paymentMethod: z.enum(["COD", "PAYPAL", "SSLCOMMERZ"]),
    quantity: z.int().min(1).max(MAX_QUANTITY).default(1),
  }).optional(),
});

export async function getOfferFulfilment(raw: unknown, db: DbReader = getDb(), now = new Date()) {
  const input = fulfilmentInput.safeParse(raw);
  if (!input.success) return { kind: "invalid" } as const;
  const { variantId, marketId, delivery } = input.data;
  const offer = await readConnectedOffer(variantId, marketId, db, now);
  if (!offer) return { kind: "hidden" } as const;
  if (!offer.eligible || !delivery) return { kind: "browse_only", offer } as const;

  const stock = await eligibleInventoryPools(db, {
    variantId, marketId, ownerId: offer.sellerId, destination: delivery.destination, paymentMethod: delivery.paymentMethod,
  });
  if (stock.kind === "delivery_unavailable") return { kind: stock.kind, offer } as const;
  return { kind: stock.available >= delivery.quantity ? "available" as const : "out_of_stock" as const,
    offer, available: stock.available };
}
