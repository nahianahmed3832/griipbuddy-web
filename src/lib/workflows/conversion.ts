import { z } from "zod";
import { getDb } from "../db/client.ts";
import { marketDay, marketDayStart, shiftCalendarDay } from "../market-calendar.ts";
import { marketConfiguration } from "../market-config.ts";
import { OperationError } from "../staff/operations.ts";
import { workflowActionInputs } from "./action-input.ts";
import { homepagePublicationResult } from "./homepage.ts";
import { appendWorkflowEvent, lockWorkflow, requireWorkflowActor } from "./service.ts";
import type { WorkflowActor } from "./types.ts";

const operationResult = z.object({ reference: z.string().optional(), spentMinor: z.int().optional(), details: z.record(z.string(), z.json()) });
const rollbackResult = z.object({ locale: z.string(), revertedReleaseId: z.uuid(), releaseId: z.uuid().nullable() });

export async function recordConversionCorrection(actor: WorkflowActor, investigationId: string, appliedHomepageWorkflowId: string, now = new Date()) {
  if (!z.uuid().safeParse(investigationId).success || !z.uuid().safeParse(appliedHomepageWorkflowId).success || investigationId === appliedHomepageWorkflowId) {
    throw new OperationError("Choose a completed homepage action as corrective evidence.");
  }
  const db = getDb();
  return db.$transaction(async tx => {
    const investigation = await lockWorkflow(tx, investigationId);
    if (!investigation || investigation.action !== "CONVERSION_TASK" || investigation.status !== "COMPLETED" || !investigation.completedAt) {
      throw new OperationError("The completed conversion investigation is unavailable.");
    }
    await requireWorkflowActor(tx, actor, investigation, true);
    const payload = workflowActionInputs.CONVERSION_TASK.safeParse(investigation.payload);
    const result = operationResult.safeParse(investigation.result);
    if (!payload.success || !payload.data.correctiveChange || !result.success) {
      throw new OperationError("The investigation does not contain a recorded corrective hypothesis and execution record.");
    }
    if (result.data.details.appliedWorkflowId === appliedHomepageWorkflowId) return investigation;
    if (result.data.details.changeApplied === true) throw new OperationError("This investigation already has a linked corrective action.");

    const applied = await tx.operationalWorkflow.findFirst({ where: { id: appliedHomepageWorkflowId, marketId: investigation.marketId,
      test: investigation.test, status: "COMPLETED", action: { in: ["HOME_PUBLISH", "HOME_ROLLBACK"] },
      completedAt: { gt: investigation.completedAt, lte: now },
    } });
    if (!applied?.completedAt) throw new OperationError("The completed action must follow the investigation and match its market and dataset.");
    const appliedDetails = operationResult.safeParse(applied.result);
    if (!appliedDetails.success || !(applied.action === "HOME_PUBLISH" ? homepagePublicationResult : rollbackResult).safeParse(appliedDetails.data.details).success) {
      throw new OperationError("A verified homepage publication or rollback record is unavailable.");
    }

    const { timeZone } = marketConfiguration(investigation.marketId);
    const firstFullDay = shiftCalendarDay(marketDay(applied.completedAt, timeZone), 1)!;
    const followUp = marketDayStart(shiftCalendarDay(firstFullDay, 7)!, timeZone)!;
    const outcomeReviewAt = followUp > investigation.outcomeReviewAt ? followUp : investigation.outcomeReviewAt;
    const updated = await tx.operationalWorkflow.update({ where: { id: investigationId }, data: { outcomeReviewAt,
      result: { ...result.data, details: { ...result.data.details, changeApplied: true, appliedWorkflowId: applied.id,
        appliedAt: applied.completedAt.toISOString() } },
    } });
    await appendWorkflowEvent(tx, investigationId, "CORRECTION_LINKED", { appliedWorkflowId: applied.id, action: applied.action,
      appliedAt: applied.completedAt.toISOString(), originalReviewAt: investigation.outcomeReviewAt.toISOString(),
      outcomeReviewAt: outcomeReviewAt.toISOString() }, actor.staffId, now);
    return updated;
  });
}
