import type { Prisma } from "../../generated/prisma/client.ts";

export const assignedAttributeSelection = {
  attributeValues: true,
  variants: {
    where: { active: true, archivedAt: null },
    select: {
      id: true, options: true, optionSignature: true, attributeValues: true,
      optionSelections: { select: { optionValue: { select: { value: true, option: { select: { key: true } } } } } },
    },
  },
} as const satisfies Prisma.ProductSelect;

type ProductAttributes = Prisma.ProductGetPayload<{ select: typeof assignedAttributeSelection }>;

function attributes(value: Prisma.JsonValue | null) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

export function assignedAttributeValues(product: ProductAttributes) {
  return {
    productValues: attributes(product.attributeValues),
    variants: product.variants.map(variant => ({
      id: variant.id, values: attributes(variant.attributeValues),
      options: variant.optionSignature === null ? variant.options
        : Object.fromEntries(variant.optionSelections.map(({ optionValue }) => [optionValue.option.key, optionValue.value])),
    })),
  };
}
