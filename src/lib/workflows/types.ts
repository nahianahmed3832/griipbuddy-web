import { z } from "zod";
import { isMarketId, marketList, type MarketId } from "../../config/markets.ts";
import type { OperationalWorkflow, Prisma } from "../../generated/prisma/client.ts";

export const workflowActions = ["HOME_DRAFT", "HOME_PUBLISH", "HOME_ROLLBACK", "PURCHASE_PROPOSAL", "TEST_PLAN", "CONVERSION_TASK", "LISTING_DRAFT"] as const;
export const workflowRoles = ["STAFF", "MERCHANDISER", "BUYER", "RESEARCHER", "ANALYST", "LISTING_EDITOR", "MANAGER"] as const;
export const workflowActionInput = z.enum(workflowActions);
export const workflowRoleInput = z.enum(workflowRoles);
export type WorkflowAction = z.infer<typeof workflowActionInput>;
export type WorkflowRole = z.infer<typeof workflowRoleInput>;
export type WorkflowActor = { staffId: string; agentRole?: Exclude<WorkflowRole, "STAFF">; agentId?: string };

export const workflowKinds = {
  HOME_DRAFT: "HOMEPAGE", HOME_PUBLISH: "HOMEPAGE", HOME_ROLLBACK: "HOMEPAGE", PURCHASE_PROPOSAL: "PURCHASING",
  TEST_PLAN: "MARKET_TEST", CONVERSION_TASK: "CONVERSION", LISTING_DRAFT: "LISTING",
} as const satisfies Record<WorkflowAction, OperationalWorkflow["kind"]>;

export const workflowCurrency = z.enum([...new Set(marketList.map(market => market.currency))]);
export const workflowMarketId = z.custom<MarketId>(isMarketId);
export const minorUnits = z.int().min(0).max(2_000_000_000);
export const workflowKey = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/);
export const workflowText = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[<>\p{Cc}]/u.test(value));
const instant = z.union([z.date(), z.iso.datetime({ offset: true })]).transform(value => new Date(value));
const jsonObject = z.record(z.string().min(1).max(100).refine(key => !["__proto__", "constructor", "prototype"].includes(key)), z.json());
const score = z.int().min(0).max(100).optional();

export const workflowInput = z.strictObject({
  marketId: workflowMarketId, test: z.boolean(), action: workflowActionInput,
  targetKey: z.string().trim().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9_.:@/-]*$/),
  title: workflowText(220), expectedOutcome: workflowText(500), uncertainty: workflowText(500),
  outcomeReviewAt: instant, evidenceExpiresAt: instant,
  evidence: z.array(z.strictObject({ kind: workflowKey, ref: workflowText(600),
    from: z.iso.date().optional(), to: z.iso.date().optional(),
  }).refine(item => !item.from || !item.to || item.from <= item.to)).min(1).max(8),
  payload: jsonObject.refine(value => Object.keys(value).length <= 32 && JSON.stringify(value).length <= 12_000),
  requestKey: workflowKey, benefit: score, confidence: score, effort: score, stock: z.int().min(0).max(10_000_000).optional(),
  budget: z.strictObject({ minor: minorUnits, currency: workflowCurrency, ledgerKey: workflowKey }).optional(),
});
export type WorkflowInput = z.input<typeof workflowInput>;
export type ParsedWorkflowInput = z.output<typeof workflowInput>;

export type WorkflowValidation = { ok: true } | { ok: false; reason: string; retryable?: boolean };
export type WorkflowResult = { reference?: string; details: Prisma.InputJsonObject; spentMinor?: number };
export type WorkflowContext = { tx: Prisma.TransactionClient; workflow: OperationalWorkflow; now: Date; idempotencyKey: string };
export type WorkflowAdapter = {
  validate(context: WorkflowContext): Promise<WorkflowValidation>;
  execute(context: WorkflowContext): Promise<WorkflowResult>;
};
export type WorkflowAdapters = Partial<Record<WorkflowAction, WorkflowAdapter>>;

export type WorkflowReviewResult = { reviewKey: string; outcome: "SUCCESSFUL" | "UNSUCCESSFUL" | "INCONCLUSIVE";
  evidence: Prisma.InputJsonObject };
export type WorkflowEvaluator = (workflow: OperationalWorkflow, now: Date) => Promise<WorkflowReviewResult | null>;
