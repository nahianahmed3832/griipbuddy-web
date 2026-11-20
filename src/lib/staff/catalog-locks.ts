import type { Prisma } from "../../generated/prisma/client.ts";

export async function lockCatalogProductQuoteRows(tx: Prisma.TransactionClient, productId: string) {
  // Match checkout's offer, variant, product order before changing published catalog data.
  await tx.$queryRaw`
    SELECT m."variantId" FROM "MarketOffer" m JOIN "Variant" v ON v."id" = m."variantId"
    WHERE v."productId" = ${productId} ORDER BY m."variantId" COLLATE "C", m."marketId" FOR UPDATE OF m
  `;
  await tx.$queryRaw`SELECT id FROM "Variant" WHERE "productId" = ${productId} ORDER BY id FOR NO KEY UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Product" WHERE id = ${productId} FOR NO KEY UPDATE`;
}
