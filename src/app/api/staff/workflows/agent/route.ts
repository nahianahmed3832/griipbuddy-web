import { NextResponse } from "next/server";
import { privateHeaders, readJson } from "@/lib/db/http";
import { consumeQuota, reportFailure } from "@/lib/db/observability";
import { OperationError } from "@/lib/staff/operations";
import { authenticateWorkflowAgent, canProposeWorkflow, workflowAgentRequest } from "@/lib/workflows/agent-access";
import { checkAgentProposalEligibility, compileAgentProposal } from "@/lib/workflows/agent-intake";
import { workflowUrl } from "@/lib/workflows/navigation";
import { createWorkflow, previewWorkflow } from "@/lib/workflows/service";

export async function POST(request: Request) {
  const response = (body: object, status = 200) => NextResponse.json(body, { status, headers: privateHeaders });
  const agent = authenticateWorkflowAgent(request.headers.get("x-griip-workflow-token"));
  if (!agent || request.headers.get("sec-fetch-site") === "cross-site") return response({ error: "Agent proposal access unavailable." }, 404);
  const body = workflowAgentRequest.safeParse(await readJson(request, 3_000));
  if (!body.success) return response({ error: "Submit a typed preview or proposal using a saved insight." }, 400);
  if (!canProposeWorkflow(agent, body.data)) return response({ error: "Agent proposal access unavailable." }, 404);
  try {
    if (!await consumeQuota("staff.workflows.agent", agent.id, 16, 60)) return response({ error: "Agent proposal rate limit reached." }, 429);
    const proposal = await compileAgentProposal(agent, body.data);
    if (!proposal) return response({ error: "Saved insight unavailable in this scope." }, 404);
    const dryRun = await previewWorkflow(proposal.actor, proposal.input);
    const policy = { version: dryRun.policy.policyVersion, mode: dryRun.policy.mode,
      requiresReview: dryRun.requiresReview, reason: dryRun.reason };
    if (body.data.mode === "preview") {
      let eligibilityReason: string | null = null;
      try { await checkAgentProposalEligibility(dryRun.input); }
      catch (error) {
        if (!(error instanceof OperationError)) throw error;
        eligibilityReason = error.message;
      }
      return response({ mode: "preview", action: dryRun.input.action, marketId: dryRun.input.marketId,
        scope: body.data.scope, expectedOutcome: dryRun.input.expectedOutcome, uncertainty: dryRun.input.uncertainty,
        outcomeReviewAt: dryRun.input.outcomeReviewAt, evidence: dryRun.input.evidence, budget: dryRun.input.budget ?? null,
        eligible: !eligibilityReason, eligibilityReason, policy, executed: false });
    }

    const stored = await createWorkflow(proposal.actor, proposal.input);
    return response({ mode: "propose", workflowId: stored.id, status: stored.status, action: stored.action,
      marketId: stored.marketId, scope: body.data.scope, policy, executed: false,
      href: workflowUrl({ market: stored.marketId, scope: body.data.scope }, stored.id) }, 201);
  } catch (error) {
    if (error instanceof OperationError) return response({ error: error.message, executed: false }, 422);
    reportFailure("workflows.agent_proposal", undefined, error);
    return response({ error: "Agent proposal temporarily unavailable.", executed: false }, 503);
  }
}
