import { Prisma } from "../../generated/prisma/client.ts";
import type { MarketId } from "../../config/markets.ts";
import { dispatchStockRelations, lockDispatchLocations, lockVariantInventory, marketStock } from "../commerce/location-inventory.ts";
import { marketHasDelivery } from "../commerce/orders.ts";
import { activeDiscount } from "../catalog/offer-price.ts";
import { marketConfiguration } from "../market-config.ts";
import { merchantProductEligibility } from "../marketplace/market-grants.ts";
import { OperationError } from "../staff/operations.ts";

export async function workflowProductEligibility(tx: Prisma.TransactionClient, action: {
  marketId: MarketId; productIds: string[]; test: boolean; now: Date; minimumStock?: number; requireDelivery?: boolean;
}) {
  const { productIds, marketId, test, now } = action;
  const { currency } = marketConfiguration(marketId);
  await tx.$queryRaw`SELECT id FROM "Product" WHERE id IN (${Prisma.join(productIds)}) ORDER BY id COLLATE "C" FOR SHARE`;
  const criteria = { id: { in: productIds }, active: true, publication: "ACTIVE" as const, ...merchantProductEligibility(marketId), ...(!test && { demo: false }) };
  const variants = await tx.variant.findMany({ where: { active: true, managedInventory: false, product: criteria }, select: { id: true }, take: 501 });
  if (variants.length > 500) throw new OperationError("Choose a smaller catalog selection to verify stock and local offers.");
  const variantIds = variants.map(row => row.id);
  await lockVariantInventory(tx, variantIds);
  await lockDispatchLocations(tx, variantIds);
  const products = await tx.product.findMany({ where: criteria, select: { id: true, name: true, revision: true, marketplaceShopId: true,
    variants: { where: { id: { in: variantIds }, active: true, managedInventory: false }, select: { ...dispatchStockRelations,
      offers: { where: { marketId, currency, eligible: true, offerId: null }, select: { amountMinor: true, discountMinor: true, discountStartsAt: true, discountEndsAt: true } },
    } },
  } });
  const eligible = products.flatMap(product => {
    const usable = product.variants.flatMap(variant => {
      const offer = variant.offers[0];
      if (!offer || offer.amountMinor < 0) return [];
      const price = offer.amountMinor - activeDiscount(offer, now);
      return price >= 0 ? [{ price, stock: marketStock(variant, marketId, product.marketplaceShopId) }] : [];
    });
    const priced = usable.filter(row => action.minimumStock ? row.stock > 0 : true);
    const availableStock = priced.reduce((sum, row) => sum + row.stock, 0);
    if (!priced.length || availableStock < (action.minimumStock ?? 0)) return [];
    return [{ id: product.id, name: product.name, revision: product.revision, stock: availableStock,
      priceMinor: Math.min(...priced.map(row => row.price)), currency }];
  });
  if (eligible.length !== productIds.length) throw new OperationError("At least one product is missing an eligible market offer or the required available stock.");
  if (action.requireDelivery && !await marketHasDelivery(marketId, tx)) throw new OperationError("Verified delivery coverage is unavailable in this market.");
  return productIds.map(id => eligible.find(product => product.id === id)!);
}
