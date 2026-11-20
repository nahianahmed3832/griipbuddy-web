import { createHash } from "node:crypto";
import { z } from "zod";
import type { OperationalWorkflow } from "../../generated/prisma/client.ts";
import { marketConfiguration } from "../market-config.ts";
import { developmentAcceptanceDatabase, localDatabase, productionDatabase, stagingDatabase } from "../db/local.ts";
import { marketDay } from "../market-calendar.ts";
import { minorUnits, workflowActionInput, workflowCurrency, workflowKey, workflowKinds, workflowMarketId, workflowRoleInput, type WorkflowAction, type WorkflowRole } from "./types.ts";

export const workflowModes = ["RECOMMENDATION_ONLY", "DRAFT_ONLY", "AUTOMATIC", "REVIEW"] as const;

const policyInput = z.strictObject({
  marketId: workflowMarketId, test: z.boolean(), role: workflowRoleInput, action: workflowActionInput,
  mode: z.enum(workflowModes), version: workflowKey.max(60), maxAttempts: z.int().min(1).max(5).default(3),
  maxRunsPerDay: z.int().min(1).max(1000).default(20),
  budget: z.strictObject({ ledgerKey: workflowKey, currency: workflowCurrency, limitMinor: minorUnits,
    automaticLimitMinor: minorUnits, validThrough: z.iso.date(),
  }).refine(budget => budget.automaticLimitMinor <= budget.limitMinor).optional(),
});
type Policy = z.output<typeof policyInput>;

const roleActions = {
  MERCHANDISER: ["HOME_DRAFT", "HOME_PUBLISH", "HOME_ROLLBACK"], BUYER: ["PURCHASE_PROPOSAL"], RESEARCHER: ["TEST_PLAN"],
  ANALYST: ["CONVERSION_TASK"], LISTING_EDITOR: ["LISTING_DRAFT"], MANAGER: ["TEST_PLAN", "CONVERSION_TASK"],
} as const satisfies Record<Exclude<WorkflowRole, "STAFF">, readonly WorkflowAction[]>;

export function roleCanUseAction(role: WorkflowRole, action: WorkflowAction) {
  if (role === "STAFF") return true;
  if (!Object.hasOwn(roleActions, role)) return false;
  return (roleActions[role] as readonly WorkflowAction[]).includes(action);
}

const policyKey = ({ marketId, role, action, test }: Pick<Policy, "marketId" | "role" | "action" | "test">) =>
  JSON.stringify([marketId, test, role, action]);

export function workflowPolicies(raw = process.env.GRIIP_WORKFLOW_POLICY): { state: "configured" | "missing" | "invalid"; policies: Policy[] } {
  if (!raw) return { state: "missing", policies: [] };
  if (raw.length > 65_536) return { state: "invalid", policies: [] };
  try {
    const policies = z.array(policyInput).max(112).parse(JSON.parse(raw));
    const keys = new Set<string>();
    const budgets = new Map<string, string>();
    for (const row of policies) {
      const key = policyKey(row);
      if (keys.has(key) || !roleCanUseAction(row.role, row.action)) return { state: "invalid", policies: [] };
      keys.add(key);
      if (!row.budget) continue;
      const { ledgerKey, currency, limitMinor, validThrough } = row.budget;
      const existing = budgets.get(JSON.stringify([row.test, ledgerKey]));
      const accounting = JSON.stringify([currency, limitMinor, validThrough]);
      if (existing && existing !== accounting) return { state: "invalid", policies: [] };
      budgets.set(JSON.stringify([row.test, ledgerKey]), accounting);
    }
    return { state: "configured", policies };
  } catch { return { state: "invalid", policies: [] }; }
}

export type EffectiveWorkflowPolicy = Omit<Policy, "version"> & {
  policyVersion: string;
  reason: string;
};

export function effectiveWorkflowPolicy(input: Pick<Policy, "marketId" | "role" | "action" | "test">): EffectiveWorkflowPolicy {
  const config = workflowPolicies();
  const configured = config.policies.find(row => policyKey(row) === policyKey(input));
  if (configured) {
    const { version, ...policy } = configured;
    const hash = createHash("sha256").update(JSON.stringify(policy)).digest("hex").slice(0, 24);
    return { ...policy, policyVersion: `${version}:${hash}`, reason: "Matched the configured market, dataset, role, and action policy." };
  }
  const mode = input.role === "STAFF" ? "DRAFT_ONLY" : "RECOMMENDATION_ONLY";
  return { ...input, mode, policyVersion: `default-v1:${mode}`, maxAttempts: 3, maxRunsPerDay: 20,
    reason: config.state === "invalid" ? "The execution policy configuration is invalid. Automatic execution is unavailable."
      : "No execution authority is configured for this market, dataset, role, and action." };
}

export const listWorkflowPolicies = (marketIds: readonly string[]) => workflowPolicies().policies.filter(row => marketIds.includes(row.marketId));

export function policyForWorkflow(workflow: Pick<OperationalWorkflow, "marketId" | "test" | "action" | "agentRole">) {
  const role = workflowRoleInput.safeParse(workflow.agentRole ?? "STAFF");
  if (!role.success || !roleCanUseAction(role.data, workflow.action)) return null;
  return effectiveWorkflowPolicy({ marketId: workflow.marketId, test: workflow.test, action: workflow.action, role: role.data });
}

export function workflowExecutionPolicy(workflow: Pick<OperationalWorkflow, "marketId" | "test" | "action" | "budgetMinor" | "budgetCurrency" | "budgetLedgerKey">,
  policy: EffectiveWorkflowPolicy, now: Date): { allowed: false; reason: string } | { allowed: true; review: boolean } {
  const market = marketConfiguration(workflow.marketId);
  if (workflow.test ? market.status !== "staging" || !localDatabase() && !developmentAcceptanceDatabase() &&
      !(process.env.GRIIP_MARKET_REVIEW_FIXTURES === "1" && stagingDatabase())
    : market.status !== "active" || !productionDatabase()) {
    return { allowed: false, reason: "The market and runtime do not authorize execution for this evidence scope." };
  }
  if (policy.mode === "RECOMMENDATION_ONLY" || policy.mode === "DRAFT_ONLY") return { allowed: false, reason: policy.reason };
  const budgetRequired = workflowKinds[workflow.action] === "MARKET_TEST" || workflowKinds[workflow.action] === "PURCHASING";
  if (workflow.budgetMinor === null && budgetRequired) return { allowed: false, reason: "A recorded budget is required for this workflow." };
  const { budget } = policy;
  if (workflow.budgetMinor !== null && (!budget || workflow.budgetCurrency !== market.currency || workflow.budgetCurrency !== budget.currency ||
      workflow.budgetLedgerKey !== budget.ledgerKey || marketDay(now, market.timeZone) > budget.validThrough)) {
    return { allowed: false, reason: "There is no current budget authority for this market, currency, and ledger." };
  }
  if (budget && workflow.budgetMinor !== null && workflow.budgetMinor > budget.limitMinor) {
    return { allowed: false, reason: "The proposal exceeds the configured ledger limit." };
  }
  return { allowed: true, review: policy.mode === "REVIEW" ||
    Boolean(budget && workflow.budgetMinor !== null && workflow.budgetMinor > budget.automaticLimitMinor) };
}
