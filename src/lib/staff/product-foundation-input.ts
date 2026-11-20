import { z } from "zod";
import { validVariantId } from "../cart/model.ts";
import { maxProductOptions, variantOptionSignature } from "../catalog/option-signature.ts";
import {
  gtinField, manufacturerText, productIdField, skuField, slugField, specificationField, textField,
} from "./catalog-input.ts";

const stableProductId = productIdField.refine(id => id !== "new", "Choose a product ID other than new.");
const variantIdField = z.string().refine(validVariantId, "Enter a valid stable variant ID.");
const attributeValues = z.record(productIdField, z.union([z.string().max(240), z.number(), z.boolean()]))
  .refine(values => Object.keys(values).length <= 100, "Use at most 100 attribute values.");
const selections = z.record(productIdField, productIdField)
  .refine(values => Object.keys(values).length <= maxProductOptions, `Select at most ${maxProductOptions} options.`);

const option = z.strictObject({
  id: productIdField,
  key: textField(1, 40),
  label: textField(1, 80),
  values: z.array(z.strictObject({
    id: productIdField,
    value: textField(1, 70),
    label: textField(1, 70),
  })).min(1).max(60),
});

const variant = z.strictObject({
  id: variantIdField,
  sku: skuField,
  active: z.boolean().default(true),
  selections,
  attributeValues: attributeValues.optional(),
  gtin: gtinField.nullish(),
  mpn: manufacturerText.nullish(),
  identifiersNotAssigned: z.boolean().optional(),
});

function unique(values: string[]) {
  return new Set(values).size === values.length;
}

function folded(value: string) {
  return value.normalize("NFKC").toLowerCase();
}

export const productFoundationInput = z.strictObject({
  id: stableProductId,
  expectedRevision: z.number().int().nonnegative().nullable(),
  slug: slugField,
  primaryCategoryId: productIdField,
  secondaryCategoryIds: z.array(productIdField).max(50).optional(),
  name: textField(2, 120),
  brand: manufacturerText.nullish(),
  description: textField(0, 4000),
  shortDescription: textField(0, 240).nullish(),
  specifications: z.array(specificationField).max(30).optional(),
  keywords: z.array(textField(1, 60)).max(20).optional(),
  featured: z.boolean().optional(),
  newArrival: z.boolean().optional(),
  publication: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]),
  attributeValues: attributeValues.optional(),
  options: z.array(option).max(maxProductOptions),
  variants: z.array(variant).max(40),
  defaultVariantId: variantIdField.nullish(),
}).superRefine((input, context) => {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
  if (!unique([input.primaryCategoryId, ...(input.secondaryCategoryIds ?? [])])) {
    issue(["secondaryCategoryIds"], "Choose each category only once.");
  }
  if (!unique((input.specifications ?? []).map(({ label }) => folded(label)))) {
    issue(["specifications"], "Use each specification name once.");
  }
  if (!unique(input.options.map(({ id }) => id)) || !unique(input.options.map(({ key }) => folded(key)))) {
    issue(["options"], "Each option ID and key must be unique.");
  }
  for (const [index, { values }] of input.options.entries()) {
    if (!unique(values.map(({ id }) => id)) || !unique(values.map(({ value }) => folded(value))) ||
        !unique(values.map(({ label }) => folded(label)))) {
      issue(["options", index, "values"], "Each option value needs a distinct ID, value and label.");
    }
  }
  if (!unique(input.variants.map(({ id }) => id))) issue(["variants"], "Each variant ID must be unique.");
  if (!unique(input.variants.map(({ sku }) => sku))) issue(["variants"], "Each SKU must be unique.");
  if (!unique(input.variants.map(row => variantOptionSignature(row.selections)))) {
    issue(["variants"], "Each variant must use a different option combination.");
  }
  for (const [index, row] of input.variants.entries()) {
    const matchesOptions = Object.keys(row.selections).length === input.options.length &&
      input.options.every(({ id, values }) => Object.hasOwn(row.selections, id) &&
        values.some(value => value.id === row.selections[id]));
    if (!matchesOptions) issue(["variants", index, "selections"], "Choose one value from each option of this product.");
  }
  const active = input.variants.filter(row => row.active);
  if (input.defaultVariantId && !active.some(row => row.id === input.defaultVariantId)) {
    issue(["defaultVariantId"], "The default must be an active variant of this product.");
  } else if (input.options.length && active.length && !input.defaultVariantId) {
    issue(["defaultVariantId"], "Choose a default from the active variants.");
  }
  if (input.publication === "ACTIVE") {
    if (!active.length) issue(["variants"], "Add an active variant to publish.");
    if (input.description.length < 10) issue(["description"], "Enter a product description of at least 10 characters to publish.");
  }
});

export type ProductFoundationInput = z.output<typeof productFoundationInput>;
