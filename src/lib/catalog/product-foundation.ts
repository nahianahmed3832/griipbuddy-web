import { z } from "zod";
import type { MarketId } from "../../config/markets.ts";
import type { Prisma } from "../../generated/prisma/client.ts";
import { connectedOfferScope } from "../commerce/market-offers.ts";
import { getDb, type DbReader } from "../db/client.ts";
import { isMarketSelectable, marketConfiguration } from "../market-config.ts";
import { merchantProductEligibility } from "../marketplace/market-grants.ts";
import { productIdField } from "../staff/catalog-input.ts";
import { catalogLocaleChain } from "./category-presentation.ts";
import { maxProductOptions, variantOptionSignature } from "./option-signature.ts";
import { catalogGalleryOrder, selectCatalogImage, selectProductContent } from "./product-presentation.ts";
import { eligibleOffer, marketImage } from "./repository.ts";

export function marketFoundationVariant(marketId: MarketId, eligibleOnly: boolean): Prisma.VariantWhereInput {
  const visibility: Prisma.VariantWhereInput[] = [{
    managedInventory: false, product: merchantProductEligibility(marketId), offers: { some: eligibleOffer(marketId) },
  }];
  if (!eligibleOnly || marketConfiguration(marketId).status !== "paused") {
    visibility.push({ offers: { some: { ...connectedOfferScope(marketId), ...(eligibleOnly && { eligible: true }) } } });
  }
  return { active: true, archivedAt: null, optionSignature: { not: null }, OR: visibility };
}

const selectionInput = z.record(productIdField, productIdField).refine(selections => Object.keys(selections).length <= maxProductOptions);

export async function resolveProductVariant(productId: string, selections: unknown, marketId: MarketId, db: DbReader = getDb()) {
  if (!isMarketSelectable(marketId)) return null;
  const input = selectionInput.safeParse(selections);
  if (!input.success) return null;
  return db.variant.findFirst({
    where: {
      ...marketFoundationVariant(marketId, true), productId, optionSignature: variantOptionSignature(input.data),
      product: { foundation: true, active: true, publication: "ACTIVE" },
    },
    select: { id: true, productId: true, sku: true },
  });
}

const imageFields = { src: true, alt: true, position: true, isPrimary: true } as const;

export async function getMarketProductFoundation(productId: string, marketId: MarketId, locale: string, db: DbReader = getDb()) {
  if (!isMarketSelectable(marketId)) return null;
  const visibility = marketFoundationVariant(marketId, false);
  const product = await db.product.findFirst({
    where: { id: productId, foundation: true, active: true, publication: "ACTIVE", variants: { some: visibility } },
    select: {
      id: true, slug: true, brand: true, name: true, description: true, shortDescription: true, departmentId: true, publication: true,
      specifications: true, attributeValues: true,
      secondaryCategories: { orderBy: { departmentId: "asc" }, select: { departmentId: true } },
      translations: { where: { locale: { in: catalogLocaleChain(locale) } },
        select: { locale: true, name: true, description: true, shortDescription: true } },
      images: { select: imageFields },
      optionDefinitions: {
        orderBy: [{ position: "asc" }, { id: "asc" }],
        select: { id: true, key: true, label: true, values: {
          orderBy: [{ position: "asc" }, { id: "asc" }], select: { id: true, value: true, label: true },
        } },
      },
      variants: {
        where: visibility, orderBy: [{ position: "asc" }, { id: "asc" }],
        select: {
          id: true, sku: true, isDefault: true, attributeValues: true, images: { select: imageFields },
          optionSelections: { select: { optionId: true, optionValueId: true } },
          compatibility: { orderBy: { modelId: "asc" }, select: { model: { select: { id: true, brand: true, name: true } } } },
        },
      },
    },
  });
  if (!product?.variants.length) return null;
  const { variants, images, translations, secondaryCategories, optionDefinitions, departmentId, ...base } = product;
  const marketAsset = <T extends { src: string }>(image: T) => ({ ...image, src: marketImage(image.src, marketId) });
  return {
    ...base, ...selectProductContent(base, translations, locale), primaryCategoryId: departmentId,
    secondaryCategoryIds: secondaryCategories.map(row => row.departmentId), options: optionDefinitions,
    images: catalogGalleryOrder(images).map(marketAsset),
    defaultVariantId: (variants.find(row => row.isDefault) ?? variants[0]).id,
    variants: variants.map(({ images: gallery, optionSelections, compatibility, ...variant }) => {
      const primaryImage = selectCatalogImage(images, gallery);
      return {
        ...variant, images: catalogGalleryOrder(gallery).map(marketAsset), primaryImage: primaryImage && marketAsset(primaryImage),
        selections: Object.fromEntries(optionSelections.map(row => [row.optionId, row.optionValueId])),
        compatibleModels: compatibility.map(row => row.model),
      };
    }),
  };
}
