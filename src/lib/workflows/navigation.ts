import type { MarketId } from "../../config/markets.ts";

export const workflowPath = "/staff/workflows";
export const workflowActions = {
  HOME_DRAFT: "Homepage draft",
  HOME_PUBLISH: "Publish homepage draft",
  HOME_ROLLBACK: "Restore homepage release",
  PURCHASE_PROPOSAL: "Purchasing proposal",
  TEST_PLAN: "Product or category test",
  CONVERSION_TASK: "Conversion investigation",
  LISTING_DRAFT: "Listing improvement",
} as const;

export const workflowStates = {
  DRAFT: "Draft", READY: "Ready", AWAITING_DECISION: "Awaiting decision", RUNNING: "Running", COMPLETED: "Completed",
  FAILED: "Failed", CANCELLED: "Cancelled", EXPIRED: "Expired",
} as const;

export function workflowUrl(options: { market?: MarketId | "all"; scope?: "live" | "test"; state?: string; view?: "queue" | "policy"; draft?: string; action?: string; previous?: string } = {},
  path?: "new" | string) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) if (value) params.set(key, value);
  return `${workflowPath}${path ? `/${encodeURIComponent(path)}` : ""}${params.size ? `?${params}` : ""}`;
}

export function workflowLabel(labels: Readonly<Record<string, string>>, value: string) {
  return labels[value] ?? value.toLowerCase().replaceAll("_", " ");
}
