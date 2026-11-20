import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { isMarketId, type MarketId } from "../../config/markets.ts";
import { roleCanUseAction } from "./policy.ts";
import { workflowRoles } from "./types.ts";

const market = z.custom<MarketId>(isMarketId);
const role = z.enum(workflowRoles.filter(value => value !== "STAFF"));
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,119}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const plain = (min: number, max: number) => z.string().trim().min(min).max(max).refine(value => !/[<>\p{Cc}]/u.test(value));

const binding = z.strictObject({
  id: identifier, staffId: identifier, role, markets: z.array(market).min(1).max(12),
  scope: z.enum(["test", "live"]), tokenSha256: digest,
}).refine(item => new Set(item.markets).size === item.markets.length);
type Binding = z.infer<typeof binding>;
export type WorkflowAgentBinding = Omit<Binding, "tokenSha256">;

const proposal = {
  mode: z.enum(["preview", "propose"]),
  marketId: market,
  scope: z.enum(["test", "live"]),
  draftId: digest,
} as const;
export const workflowAgentRequest = z.discriminatedUnion("action", [
  z.strictObject({ ...proposal, action: z.literal("HOME_DRAFT"), ranking: z.literal("recommended").optional() }),
  z.strictObject({ ...proposal, action: z.literal("PURCHASE_PROPOSAL") }),
  z.strictObject({ ...proposal, action: z.literal("TEST_PLAN"), durationDays: z.int().min(1).max(56).optional(),
    minimumStock: z.int().min(1).max(100_000).optional(), successMetric: z.enum(["verified-paid-orders", "product-to-cart"]).optional(),
    successThreshold: z.int().min(1).max(100_000).optional() }),
  z.strictObject({ ...proposal, action: z.literal("CONVERSION_TASK"), area: z.enum(["funnel", "payment", "search"]).optional() }),
  z.strictObject({ ...proposal, action: z.literal("LISTING_DRAFT"), listingName: plain(2, 120).optional(), shortDescription: plain(3, 300).optional() })
    .refine(value => Boolean(value.listingName || value.shortDescription), "Supply a proposed listing field."),
]);
export type WorkflowAgentRequest = z.infer<typeof workflowAgentRequest>;
export type WorkflowAgentAction = WorkflowAgentRequest["action"];

export function configuredWorkflowAgents(input = process.env.GRIIP_WORKFLOW_AGENTS): {
  state: "configured" | "unconfigured" | "invalid";
  bindings: readonly Binding[];
} {
  if (!input) return { state: "unconfigured", bindings: [] };
  if (input.length > 24_000) return { state: "invalid", bindings: [] };
  try {
    const parsed = z.array(binding).min(1).max(40).safeParse(JSON.parse(input));
    if (parsed.success && new Set(parsed.data.map(item => item.tokenSha256)).size === parsed.data.length &&
        new Set(parsed.data.map(item => item.id)).size === parsed.data.length) return { state: "configured", bindings: parsed.data };
  } catch { /* Invalid runtime identity settings fail closed. */ }
  return { state: "invalid", bindings: [] };
}

export function authenticateWorkflowAgent(token: string | null, input = process.env.GRIIP_WORKFLOW_AGENTS): WorkflowAgentBinding | null {
  if (!token || !/^[A-Za-z0-9_-]{43,128}$/.test(token)) return null;
  const value = createHash("sha256").update(token).digest();
  let match: Binding | undefined;
  for (const item of configuredWorkflowAgents(input).bindings) {
    if (timingSafeEqual(value, Buffer.from(item.tokenSha256, "hex"))) match = item;
  }
  return match ? { id: match.id, staffId: match.staffId, role: match.role, markets: match.markets, scope: match.scope } : null;
}

export function canProposeWorkflow(agent: WorkflowAgentBinding, request: WorkflowAgentRequest) {
  return agent.scope === request.scope && agent.markets.includes(request.marketId) && roleCanUseAction(agent.role, request.action);
}
