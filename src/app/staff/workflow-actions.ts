"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { reportFailure } from "@/lib/db/observability";
import { marketDayStart } from "@/lib/market-calendar";
import { marketConfiguration } from "@/lib/market-config";
import { stableMeasurementId } from "@/lib/measurement/domain";
import { requireStaff } from "@/lib/staff/access";
import { OperationError } from "@/lib/staff/operations";
import { workflowAdapters } from "@/lib/workflows/adapters";
import { recordConversionCorrection } from "@/lib/workflows/conversion";
import { workflowUrl } from "@/lib/workflows/navigation";
import { evaluateWorkflowOutcome } from "@/lib/workflows/outcomes";
import { createWorkflow, decideWorkflow, getWorkflow, recordWorkflowReview, workflowAccess } from "@/lib/workflows/service";
import { compileWorkflowIntake, defaultOutcomeDay } from "@/lib/workflows/staff-intake";
import type { WorkflowActor } from "@/lib/workflows/types";
import { dryRunWorkflow, runNextWorkflow } from "@/lib/workflows/worker";

type State = { message?: string };
const commandInput = z.enum(["ready", "approve", "cancel", "retry", "release", "run", "dry-run", "review", "publish", "rollback", "record-correction"]);

function errorMessage(error: unknown) {
  if (error instanceof OperationError) return { message: error.message };
  reportFailure("workflow.staff-command", undefined, error);
  return { message: "The workflow operation is temporarily unavailable." };
}

function refreshWorkflow(id: string) {
  revalidatePath(workflowUrl());
  revalidatePath(workflowUrl({}, id));
}

function dispatchWorkflow(id: string) {
  after(async () => {
    try { await runNextWorkflow({ adapters: workflowAdapters, workflowId: id, workerId: "staff-request" }); }
    catch (error) { reportFailure("workflow.dispatch", undefined, error); }
  });
}

export async function createWorkflowAction(_: State, form: FormData): Promise<State> {
  const actor = { staffId: (await requireStaff()).id };
  let id: string;
  try {
    const input = await compileWorkflowIntake(actor, form);
    const workflow = await createWorkflow(actor, input);
    id = workflow.id;
    if (form.get("queue") === "on") {
      const queued = await decideWorkflow(actor, id, "ready");
      if (queued.status === "READY") dispatchWorkflow(id);
    }
  } catch (error) { return errorMessage(error); }
  refreshWorkflow(id);
  redirect(workflowUrl({}, id));
}

async function relatedWorkflow(actor: WorkflowActor, previousId: string, command: "publish" | "rollback") {
  const source = await getWorkflow(actor.staffId, previousId);
  const required = command === "publish" ? "HOME_DRAFT" : "HOME_PUBLISH";
  if (!source || source.status !== "COMPLETED" || source.action !== required) throw new OperationError("The required completed homepage workflow is unavailable.");
  const market = marketConfiguration(source.marketId);
  const result = z.object({ details: z.object({ locale: z.string() }) }).safeParse(source.result);
  if (!result.success || !market.languages.includes(result.data.details.locale)) throw new OperationError("The recorded homepage locale is unavailable.");
  const { locale } = result.data.details;
  const now = new Date();
  const date = marketDayStart(defaultOutcomeDay(market.id, now), market.timeZone)!;
  const action = command === "publish" ? "HOME_PUBLISH" : "HOME_ROLLBACK";
  const proposed = await createWorkflow(actor, { marketId: source.marketId, test: source.test, action, targetKey: source.targetKey,
    title: `${command === "publish" ? "Publish" : "Restore before"} · ${source.title}`.slice(0, 220),
    expectedOutcome: command === "publish" ? "Record at least 20 verified visible impressions for the new homepage configuration." : "Restore the previously recorded homepage configuration.",
    uncertainty: command === "publish" ? "Exposure evidence does not establish sales lift. A matching experiment is required for a causal estimate." : "A newer draft or publication can prevent a safe automatic restore.",
    evidence: [{ kind: "workflow", ref: source.id }], outcomeReviewAt: date,
    evidenceExpiresAt: command === "publish" ? source.evidenceExpiresAt : date,
    requestKey: stableMeasurementId("workflow-homepage-follow-up", String(command), source.id),
    payload: command === "publish" ? { locale, draftWorkflowId: source.id, minimumImpressions: 20 } : { locale, publishWorkflowId: source.id },
  }, now);
  return proposed.id;
}

export async function workflowCommandAction(_: State, form: FormData): Promise<State> {
  const actor = { staffId: (await requireStaff()).id };
  const id = z.uuid().safeParse(form.get("id")), cmd = commandInput.safeParse(form.get("command"));
  if (!id.success || !cmd.success) return { message: "The workflow command is unavailable." };
  const identifier = id.data;
  let next: string | undefined;
  try {
    if (cmd.data === "publish" || cmd.data === "rollback") next = await relatedWorkflow(actor, identifier, cmd.data);
    else if (cmd.data === "record-correction") {
      const applied = z.uuid().safeParse(form.get("appliedWorkflow"));
      if (!applied.success) return { message: "Enter the ID of a completed homepage change." };
      await recordConversionCorrection(actor, identifier, applied.data);
      refreshWorkflow(identifier);
      return { message: "The completed change was linked for follow-up measurement." };
    }
    else if (cmd.data === "dry-run") {
      const preview = await dryRunWorkflow(actor, identifier, workflowAdapters);
      return { message: preview.reason ?? (preview.requiresReview ? "Checks passed. This action requires a staff decision." : "Current policy and eligibility checks passed. Dry run made no changes.") };
    } else if (cmd.data === "run" || cmd.data === "review") {
      const workflow = await getWorkflow(actor.staffId, identifier);
      if (!workflow || !await workflowAccess(getDb(), actor, workflow.marketId, workflow.action)) throw new OperationError("Workflow unavailable to this account.");
      if (cmd.data === "run") {
        const result = await runNextWorkflow({ adapters: workflowAdapters, workflowId: identifier, workerId: "staff-request" });
        refreshWorkflow(identifier);
        return { message: result ? "The job attempt finished. See execution status for its result." : "No job is currently due for this workflow." };
      }
      const now = new Date();
      const review = await evaluateWorkflowOutcome(workflow, now);
      if (!review) return { message: "The review date or evidence window is still pending." };
      await recordWorkflowReview(actor, identifier, review, now);
    } else {
      const workflow = await decideWorkflow(actor, identifier, cmd.data);
      if (workflow.status === "READY" && ["ready", "retry", "approve"].includes(cmd.data)) dispatchWorkflow(identifier);
      refreshWorkflow(identifier);
      return { message: workflow.blockReason ?? (workflow.status === "READY" ? "The workflow is queued. Execution status is recorded separately." : "Workflow updated.") };
    }
  } catch (error) { return errorMessage(error); }
  refreshWorkflow(identifier);
  if (next) redirect(workflowUrl({}, next));
  return { message: "Outcome review recorded." };
}
