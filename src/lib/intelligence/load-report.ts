import { productIntelligence } from "./dataset.ts";
import { buildOpportunityAssessments, previousOpportunityWindow } from "./opportunities.ts";
import type { IntelligenceInput, ProductIntelligenceReport } from "./types.ts";

export async function loadOpportunityAssessments(report: ProductIntelligenceReport, input: IntelligenceInput) {
  const previous = previousOpportunityWindow(report.window);
  const comparison = previous ? await productIntelligence({ ...input, ...previous }).catch(() => null) : null;
  return buildOpportunityAssessments(report, comparison?.kind === "report" ? comparison : undefined);
}
