import { z } from "zod";
import { marketIds, retailMarketIds } from "../../config/markets.ts";
import { checkoutInput } from "../commerce/checkout-types.ts";
import { orderRecoveryToken } from "../commerce/order-recovery.ts";
import { MAX_PERSONALIZATION_PROMPT } from "../catalog/personalization.ts";
import { addressCommands } from "./address-command.ts";

const name = (min: number, max: number) => z.string().trim().min(min).max(max);
const uuid = z.uuid();
const product = name(1, 100).regex(/^p-[a-z0-9-]+$/);
const slug = name(3, 60).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const prose = (max: number) => name(0, max);
const market = z.enum(retailMarketIds);
const accountMarket = z.enum(marketIds);
const price = z.number().int().min(100).max(10_000_000);

export const marketplaceCommand = z.discriminatedUnion("action", [
  z.object({ action: z.literal("favorite"), product, selected: z.boolean() }),
  z.object({ action: z.literal("follow"), shop: uuid, selected: z.boolean() }),
  z.object({ action: z.literal("create-list"), name: name(2, 60), registry: z.boolean() }),
  z.object({ action: z.literal("edit-list"), list: uuid, name: name(2, 60), public: z.boolean() }),
  z.object({ action: z.literal("delete-list"), list: uuid }),
  z.object({ action: z.literal("list-item"), list: uuid, product, selected: z.boolean() }),
  z.object({ action: z.literal("claim-order"), order: uuid, marketId: accountMarket.optional(), trackingToken: orderRecoveryToken.optional() }),
  z.object({ action: z.literal("review"), order: uuid, marketId: accountMarket.optional(), product, stars: z.number().int().min(1).max(5), text: name(5, 1200) }),
  z.object({ action: z.literal("open-message"), shop: uuid, order: uuid.optional(), subject: name(2, 100), text: name(2, 1600) }),
  z.object({ action: z.literal("reply"), thread: uuid, text: name(2, 1600) }),
  z.object({ action: z.literal("close-thread"), thread: uuid }),
  z.object({ action: z.literal("create-shop"), name: name(3, 60), slug, about: name(10, 1600) }),
  z.object({ action: z.literal("edit-shop"), name: name(3, 60), announcement: prose(200), about: name(10, 1600) }),
  z.object({ action: z.literal("draft-listing"), id: product.optional(), name: name(3, 120), description: name(10, 2200),
    department: name(2, 100), tags: prose(300), sku: name(2, 47).regex(/^[a-z0-9][a-z0-9-]*$/i),
    amount: price.optional(), quantity: z.number().int().min(0).max(1000),
    marketPrices: z.partialRecord(market, price).optional(),
    personalization: z.object({
      prompt: name(1, MAX_PERSONALIZATION_PROMPT).refine(value => !/[\p{Cc}\u2028\u2029]/u.test(value)),
      required: z.boolean(),
    }).strict().nullable().optional(),
  }),
  z.object({ action: z.literal("save-address"), label: name(2, 60), customer: checkoutInput.shape.customer }),
  z.object({ action: z.literal("delete-address"), address: uuid }),
  ...addressCommands,
  z.object({ action: z.literal("staff-shop"), shop: uuid, published: z.boolean() }),
  z.object({ action: z.literal("staff-review"), review: uuid, visible: z.boolean() }),
  z.object({ action: z.literal("request-market"), marketId: market }),
  z.object({ action: z.literal("staff-market-grant"), shop: uuid, marketId: market,
    status: z.enum(["APPROVED", "DENIED"]) }),
]);

export type MarketplaceCommand = z.infer<typeof marketplaceCommand>;
