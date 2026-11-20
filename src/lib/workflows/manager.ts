import type { Currency, MarketId } from "../../config/markets.ts";
import { marketDay } from "../market-calendar.ts";
import { marketConfiguration } from "../market-config.ts";
import { merchandisingEnabled, merchandisingRunnerConnection } from "../staff/merchandising-config.ts";
import { configuredWorkflowAgents } from "./agent-access.ts";

export type WorkflowPriorityBudget = {
  marketId: MarketId;
  test: boolean;
  ledgerKey: string;
  currency: Currency;
  /** Remaining authority for additional commitments after existing reservations. */
  availableMinor: number | null;
  validThrough?: string;
};

type PriorityWorkflow = {
  id: string;
  marketId: MarketId;
  test: boolean;
  action: string;
  status: string;
  createdAt: Date;
  benefit?: number | null;
  confidence?: number | null;
  effort?: number | null;
  stock?: number | null;
  budgetMinor?: number | null;
  budgetCurrency?: string | null;
  budgetLedgerKey?: string | null;
  committedMinor?: number | null;
};

export type WorkflowPriority = { score: number; level: "blocked" | "high" | "normal" | "low"; reasons: string[] };

const stockSensitive = new Set(["HOME_DRAFT", "HOME_PUBLISH", "TEST_PLAN"]);
const budgetSensitive = new Set(["PURCHASE_PROPOSAL", "TEST_PLAN"]);
const terminal = new Set(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);
const ledgerIndex = (marketId: MarketId, test: boolean, ledgerKey: string, currency: string) =>
  JSON.stringify([marketId, test, ledgerKey, currency]);

function bounded(value: number | null | undefined, maximum: number) {
  return value !== undefined && value !== null && Number.isFinite(value) ? Math.max(0, Math.min(maximum, value)) : null;
}

/** An explainable review order. Scores neither authorize work nor measure causal lift. */
export function prioritizeWorkflows<T extends PriorityWorkflow>(work: readonly T[], budgets: readonly WorkflowPriorityBudget[] = [], now = new Date()) {
  const authority = new Map(budgets.map(budget => [ledgerIndex(budget.marketId, budget.test, budget.ledgerKey, budget.currency), budget]));
  return work.map(workflow => {
    const reasons: string[] = [];
    const benefit = bounded(workflow.benefit, 100);
    const confidence = bounded(workflow.confidence, 100);
    const effort = bounded(workflow.effort, 100);
    const stock = bounded(workflow.stock, Number.MAX_SAFE_INTEGER);
    let constrained = false;

    if (benefit === null) reasons.push("Expected benefit is unscored.");
    else reasons.push(`Benefit ${benefit}/100.`);
    if (confidence === null) reasons.push("Confidence is unscored.");
    else reasons.push(`Confidence ${confidence}/100.`);
    if (effort === null) reasons.push("Effort is unscored.");
    else reasons.push(`Effort ${effort}/100.`);

    let score = (benefit ?? 35) * (0.5 + (confidence ?? 30) / 200) - (effort ?? 50) * 0.25;
    if (stockSensitive.has(workflow.action)) {
      if (stock === null) reasons.push("Available stock needs verification.");
      else if (stock === 0) {
        reasons.push("No available stock was recorded for this proposal.");
        constrained = true;
      } else reasons.push(`Available stock in the proposal: ${stock}.`);
    } else if (workflow.action === "PURCHASE_PROPOSAL" && stock !== null) {
      // A low balance raises investigation priority for replenishment. It does
      // not make a purchase eligible or substitute for a replenishment range.
      score += stock === 0 ? 10 : stock <= 5 ? 5 : 0;
      reasons.push(`Available stock in the proposal: ${stock}.`);
    }

    const budget = workflow.budgetMinor;
    if (budget !== null && budget !== undefined) {
      const ledger = workflow.budgetLedgerKey && workflow.budgetCurrency ? authority.get(ledgerIndex(
        workflow.marketId, workflow.test, workflow.budgetLedgerKey, workflow.budgetCurrency)) : undefined;
      const expired = ledger?.validThrough && ledger.validThrough < marketDay(now, marketConfiguration(workflow.marketId).timeZone);
      if (expired) {
        reasons.push("The supplied budget authority has expired.");
        constrained = true;
      } else if (budget > 0 && (workflow.committedMinor ?? 0) >= budget) {
        reasons.push("The workflow has a recorded budget commitment.");
      } else if (ledger?.availableMinor === null || ledger?.availableMinor === undefined) {
        reasons.push("Current authority for the requested budget is unavailable.");
        constrained = true;
      } else if (ledger.availableMinor < budget) {
        reasons.push("The requested budget exceeds the remaining authority in this ledger.");
        constrained = true;
      } else reasons.push("The requested budget fits the supplied remaining authority.");
    } else if (budgetSensitive.has(workflow.action)) {
      reasons.push("No authorized proposal budget is recorded.");
      constrained = true;
    }

    if (workflow.status === "AWAITING_DECISION") reasons.push("A staff decision is waiting.");
    if (terminal.has(workflow.status)) {
      reasons.push("This workflow is no longer in the active queue.");
      score = 0;
    }
    const rounded = Math.max(0, Math.min(100, Math.round(score)));
    const level = terminal.has(workflow.status) ? "low" : constrained ? "blocked" : rounded >= 60 ? "high" : rounded >= 28 ? "normal" : "low";
    return { workflow, priority: { score: rounded, level, reasons } satisfies WorkflowPriority };
  }).sort((left, right) => Number(terminal.has(left.workflow.status)) - Number(terminal.has(right.workflow.status)) ||
    Number(left.priority.level === "blocked") - Number(right.priority.level === "blocked") ||
    right.priority.score - left.priority.score || +left.workflow.createdAt - +right.workflow.createdAt ||
    left.workflow.id.localeCompare(right.workflow.id));
}

export function workflowManagerStatus() {
  return {
    prioritization: "deterministic" as const,
    agentBridge: configuredWorkflowAgents().state,
    listingHarness: merchandisingEnabled() && merchandisingRunnerConnection() ? "configured" as const : "unavailable" as const,
  };
}
