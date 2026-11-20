import { z } from "zod";

export const workflowProductId = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
const text = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[<>\p{Cc}]/u.test(value));
const locale = z.string().trim().min(2).max(35);
const localTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const productIds = z.array(workflowProductId).min(1).max(12).refine(ids => new Set(ids).size === ids.length);

export const workflowActionInputs = {
  HOME_DRAFT: z.strictObject({ locale, productIds, sectionTitle: text(90).refine(title => title.length >= 2),
    startsLocal: localTime.optional(), endsLocal: localTime.optional(), rankingPlacement: z.enum(["recommended"]).optional() })
    .refine(input => !input.rankingPlacement || !input.startsLocal && !input.endsLocal, "Schedule a curated collection, or draft an unscheduled ranking change."),
  HOME_PUBLISH: z.strictObject({ locale, draftWorkflowId: z.uuid(), minimumImpressions: z.int().min(1).max(10_000_000).default(20) }),
  HOME_ROLLBACK: z.strictObject({ locale, publishWorkflowId: z.uuid() }),
  PURCHASE_PROPOSAL: z.strictObject({ draftId: z.string().regex(/^[a-f0-9]{64}$/) }),
  TEST_PLAN: z.strictObject({ productIds, audience: z.literal("eligible-market-visitors"), minimumStock: z.int().min(1).max(100_000),
    durationDays: z.int().min(1).max(56), successMetric: z.enum(["verified-paid-orders", "product-to-cart"]),
    successThreshold: z.int().min(1).max(1_000_000), stoppingRule: text(400) }),
  CONVERSION_TASK: z.strictObject({ area: z.enum(["funnel", "payment", "search"]), facts: z.array(text(500)).min(1).max(8),
    hypotheses: z.array(text(500)).min(1).max(8), correctiveChange: text(500).optional(),
    appliedWorkflowId: z.uuid().optional(),
    successMetric: z.enum(["product-to-cart", "payment-failures", "zero-result-searches"]).optional(),
    successThreshold: z.int().min(0).max(1_000_000).optional() }).refine(input =>
    (input.successMetric === undefined) === (input.successThreshold === undefined) && (!input.appliedWorkflowId || Boolean(input.correctiveChange)),
    "Provide both the outcome metric and threshold, and describe any applied change."),
  LISTING_DRAFT: z.strictObject({ productId: workflowProductId, changes: z.strictObject({
    name: text(160).optional(), shortDescription: text(300).optional(), keywords: z.array(text(55)).min(1).max(16).optional(),
  }).refine(changes => Object.keys(changes).length > 0, "Choose at least one listing field to review.") }),
} as const;
