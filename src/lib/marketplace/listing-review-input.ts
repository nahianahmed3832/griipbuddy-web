import { z } from "zod";
import { marketIdInput } from "../market-config.ts";
import { catalogImage, productIdField, textField } from "../staff/catalog-input.ts";

export class ListingReviewError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message);
  }
}

const revision = z.int().min(0).max(2_147_483_646);
const optionName = textField(1, 40).regex(/^[\p{L}\p{N}][\p{L}\p{N} _-]*$/u);
const optionValue = textField(1, 70);

export const sellerListingVariant = z.strictObject({
  id: productIdField.optional(),
  sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,31}$/),
  label: textField(1, 80),
  options: z.record(optionName, optionValue).refine(options => Object.keys(options).length <= 4),
  amountMinor: z.int().min(1).max(15_000_000).nullable(),
  isDefault: z.boolean(),
  retired: z.boolean().optional(),
});

export const sellerListingDraft = z.strictObject({
  name: textField(2, 120),
  description: textField(0, 4000),
  departmentId: productIdField,
  image: catalogImage.nullish(),
  variants: z.array(sellerListingVariant).max(24),
});

export type SellerListingDraft = z.infer<typeof sellerListingDraft>;
export type SellerListingVariant = z.infer<typeof sellerListingVariant>;

const existing = { marketId: marketIdInput, productId: productIdField, revision };
export const sellerListingCommand = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("save"), marketId: marketIdInput, productId: productIdField.optional(),
    revision: revision.optional(), operationId: z.uuid().optional(), draft: sellerListingDraft,
  }),
  z.strictObject({ action: z.literal("submit"), ...existing }),
  z.strictObject({ action: z.literal("withdraw"), ...existing }),
]);

export const listingReviewDecision = z.strictObject({
  productId: productIdField, revision, decision: z.enum(["approve", "reject", "publish"]), feedback: textField(1, 1000).optional(),
}).refine(fields => fields.decision !== "reject" || Boolean(fields.feedback), {
  path: ["feedback"], message: "Explain what the seller should change before resubmitting.",
});

export function listingInput<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  throw new ListingReviewError(issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message, 400);
}

export function listingOptionKey(label: string) {
  return label.normalize("NFKC").toLowerCase().trim().replace(/[ _-]+/gu, "-");
}

export function listingOptions(variant: SellerListingVariant) {
  return Object.entries(variant.options).map(([label, value]) => ({ key: listingOptionKey(label), label, value }))
    .sort((left, right) => left.key.localeCompare(right.key, "en"));
}

export function validateListingDraft(draft: SellerListingDraft, submitting: boolean) {
  const { variants, description, image } = draft;
  const ids = variants.flatMap(variant => variant.id ? [variant.id] : []);
  const active = variants.filter(variant => !variant.retired);
  const options = variants.map(listingOptions);

  if (new Set(variants.map(variant => variant.sku)).size !== variants.length || new Set(ids).size !== ids.length) {
    throw new ListingReviewError("Use a different SKU and identifier for each variant.");
  }
  if (variants.some(variant => variant.retired && (!variant.id || variant.isDefault || variant.amountMinor !== null))) {
    throw new ListingReviewError("Only an issued variant can be retired. Clear its price and primary selection.");
  }
  if (options.some(row => row.some(option => option.key.length > 40) || new Set(row.map(({ key }) => key)).size !== row.length)) {
    throw new ListingReviewError("Use each option name only once per variant.");
  }
  const combinations = options.map(row => JSON.stringify(row.map(({ key, value }) => [key, value.normalize("NFKC").toLowerCase()])));
  if (new Set(combinations).size !== combinations.length) {
    throw new ListingReviewError("Use a different option combination for each variant.");
  }
  if (new Set(options.map(row => JSON.stringify(row.map(({ key }) => key)))).size > 1) {
    throw new ListingReviewError("Complete the same option dimensions on every variant.");
  }
  if (active.filter(variant => variant.isDefault).length > 1) {
    throw new ListingReviewError("Choose one primary variant.");
  }
  if (submitting && (description.length < 10 || !image)) {
    throw new ListingReviewError("Provide a product description of at least 10 characters and an image with alternative text.");
  }
  if (submitting && (!active.some(variant => variant.amountMinor !== null) || !active.some(variant => variant.isDefault))) {
    throw new ListingReviewError("Choose one primary variant and price at least one active variant in this market.");
  }
}
export function listingSku(shopId: string, suffix: string) {
  return `M${shopId.replaceAll("-", "").slice(0, 12)}-${suffix}`.toUpperCase();
}

