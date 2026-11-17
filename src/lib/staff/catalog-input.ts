import { z } from "zod";
import { markets, retailMarketIds, type RetailMarketId } from "../../config/markets.ts";
import { validGtin } from "../catalog/identifiers.ts";

export const slugField = z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120);
export const MAX_GALLERY_IMAGES = 96;
export const productIdField = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,79}$/);
const skuField = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9._ &+\-]{0,59}$/);
export const textField = (min: number, max: number) => z.string().trim().min(min).max(max);
const manufacturerText = textField(1, 70).regex(/^[^<>\p{Cc}]+$/u, "Use plain text for the manufacturer identifier.");
const gtinField = z.string().trim().max(28).transform((value) => value.replace(/[ -]/g, "")).refine(
  validGtin, "Enter the manufacturer-assigned GTIN with a valid length, prefix and check digit.",
);
const imagePath = z.string().regex(/^\/(?:media\/[a-f0-9]{64}|(?:catalog|editorial)\/[a-z0-9-]+\.webp)$/);
export const catalogImage = z.object({ src: imagePath, alt: textField(1, 180) }).strict();
const attribute = z.object({ label: textField(1, 60), value: textField(1, 240) }).strict();
const options = z.record(textField(1, 40), textField(1, 70)).refine((value) => Object.keys(value).length <= 4);
const offer = z.object({
  marketId: z.enum(retailMarketIds),
  currency: z.enum(["BDT", "USD"]),
  amountMinor: z.number().int().min(1).max(15_000_000),
  eligible: z.boolean(),
}).strict().refine((value) => value.currency === markets[value.marketId].currency, "Currency must match the selected market.");
const variant = z.object({
  sku: skuField, options, active: z.boolean(), image: catalogImage.optional(),
  gtin: gtinField.nullish(), mpn: manufacturerText.nullish(), identifiersNotAssigned: z.boolean().optional(),
  offers: z.array(offer).max(2).refine((value) => unique(value.map(({ marketId }) => marketId)), "List each market once per SKU."),
}).strict().refine(({ identifiersNotAssigned, gtin, mpn }) => !identifiersNotAssigned || (!gtin && !mpn), {
  path: ["identifiersNotAssigned"],
  message: "Remove the GTIN and manufacturer part number before marking identifiers as unassigned.",
});

function unique(values: readonly string[]) {
  return values.length === new Set(values).size;
}

export const productInput = z.object({
  id: productIdField.refine((value) => value !== "new", "Choose a product ID other than new."),
  slug: slugField, name: textField(2, 120), brand: manufacturerText.nullish(), departmentId: productIdField,
  description: textField(0, 4000), shortDescription: textField(0, 240).optional(), specifications: z.array(attribute).max(30),
  keywords: z.array(textField(1, 60)).max(20), collectionIds: z.array(productIdField).max(20),
  images: z.array(catalogImage).max(MAX_GALLERY_IMAGES), variants: z.array(variant).max(40),
  publication: z.enum(["DRAFT", "ACTIVE", "ARCHIVED"]), demo: z.boolean(), featured: z.boolean(), newArrival: z.boolean(),
}).strict().superRefine((value, ctx) => {
  const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
  if (!unique(value.collectionIds)) issue("collectionIds", "Select each collection once.");
  if (!unique(value.images.map(({ src }) => src))) issue("images", "Use each gallery image once.");
  if (!unique(value.variants.map(({ sku }) => sku))) issue("variants", "Each SKU must be unique.");
  if (!unique(value.specifications.map(({ label }) => label.toLowerCase()))) issue("specifications", "Use each attribute name once.");
  if (value.publication !== "ACTIVE") return;
  if (value.description.length < 10) issue("description", "Enter a product description of at least 10 characters to publish.");
  if (!value.images.length) issue("images", "Add a gallery image with alternative text to publish.");
  const active = value.variants.filter((item) => item.active);
  if (!active.length) issue("variants", "Add an active variant to publish.");
  const combinations = active.map((item) => JSON.stringify(Object.entries(item.options).sort()));
  if (!unique(combinations)) issue("variants", "Active variants must have different option combinations.");
  if (new Set(active.map((item) => JSON.stringify(Object.keys(item.options).sort()))).size > 1) {
    issue("variants", "Use the same option names on all active variants.");
  }
  if (active.some((item) => !item.offers.some((price) => price.eligible))) {
    issue("variants", "Each active variant needs a valid price in at least one eligible market.");
  }
});

export type ProductInput = z.infer<typeof productInput>;
export type VariantInput = ProductInput["variants"][number];

export function mergeCatalogIdentifiers(input: ProductInput, previous?: ProductInput | null): ProductInput {
  if (!previous) return input;
  return {
    ...input,
    brand: input.brand === undefined ? previous.brand : input.brand,
    variants: input.variants.map((variant) => {
      const prior = previous.variants.find(({ sku }) => sku === variant.sku);
      return {
        ...variant,
        gtin: variant.gtin === undefined ? prior?.gtin : variant.gtin,
        mpn: variant.mpn === undefined ? prior?.mpn : variant.mpn,
        identifiersNotAssigned: variant.identifiersNotAssigned ?? prior?.identifiersNotAssigned,
      };
    }),
  };
}

export function validationMessage(error: z.ZodError) {
  return error.issues.slice(0, 8).map(({ path, message }) => path.length ? `${path.join(".")}: ${message}` : message).join(" · ");
}

export function parseMinorUnits(value: unknown): number {
  if (typeof value !== "string" || !/^\d{1,6}(\.\d{1,2})?$/.test(value.trim())) return NaN;
  const [whole, fraction = ""] = value.trim().split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

export function readMarketOffer(marketId: RetailMarketId, amount: FormDataEntryValue | null, eligible: boolean) {
  if (amount === null || amount === "") {
    if (!eligible) return [];
  }
  return [{ marketId, currency: markets[marketId].currency, amountMinor: parseMinorUnits(amount), eligible }];
}
