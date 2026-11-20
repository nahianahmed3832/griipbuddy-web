import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import test from "node:test";
import { authenticateWorkflowAgent, canProposeWorkflow, configuredWorkflowAgents, workflowAgentRequest } from "../src/lib/workflows/agent-access.ts";
import { prioritizeWorkflows } from "../src/lib/workflows/manager.ts";

test("manager priority is deterministic, explains constrained proposals, and uses evidence and effort", () => {
  const row = { marketId: "bd", test: true, action: "HOME_DRAFT", status: "DRAFT", createdAt: new Date("2026-11-18") } as const;
  const workflows = [
    { ...row, id: "complete", status: "COMPLETED", benefit: 100, confidence: 100, effort: 0, stock: 10 },
    { ...row, id: "stockout", benefit: 100, confidence: 100, effort: 0, stock: 0 },
    { ...row, id: "weak", benefit: 100, confidence: 10, effort: 90, stock: 4 },
    { ...row, id: "strong", benefit: 80, confidence: 90, effort: 10, stock: 8 },
  ];
  const outcome = prioritizeWorkflows(workflows);
  assert.deepEqual(outcome.map(entry => entry.workflow.id), ["strong", "weak", "stockout", "complete"]);
  assert.equal(outcome[0].priority.level, "high");
  assert.match(outcome[0].priority.reasons.join(" "), /Confidence 90\/100.*Effort 10\/100.*stock.*8/);
  assert.equal(outcome[2].priority.level, "blocked");
  assert.match(outcome[2].priority.reasons.join(" "), /No available stock/);
});

test("manager compares acquisition budget only within the same market, scope, ledger, and currency", () => {
  const row = { id: "purchase", marketId: "bd", test: true, action: "PURCHASE_PROPOSAL", status: "DRAFT", createdAt: new Date(),
    stock: 1, budgetMinor: 12_000, budgetCurrency: "BDT", budgetLedgerKey: "inventory" } as const;
  const wrongAuthority = [
    { marketId: "us", test: true, currency: "USD", ledgerKey: "inventory", availableMinor: 99_000 },
    { marketId: "bd", test: false, currency: "BDT", ledgerKey: "inventory", availableMinor: 99_000 },
  ] as const;
  assert.equal(prioritizeWorkflows([row], wrongAuthority)[0].priority.level, "blocked");
  const threshold = [{ marketId: "bd", test: true, currency: "BDT", ledgerKey: "inventory", availableMinor: 11_999 }] as const;
  assert.match(prioritizeWorkflows([row], threshold)[0].priority.reasons.join(" "), /exceeds the remaining authority/);
  assert.notEqual(prioritizeWorkflows([{ ...row, committedMinor: 12_000 }], wrongAuthority)[0].priority.level, "blocked");
  assert.match(prioritizeWorkflows([row], [{ ...threshold[0], availableMinor: 12_000, validThrough: "2026-11-17" }],
    new Date("2026-11-18T12:00Z"))[0].priority.reasons.join(" "), /has expired/);
  assert.equal(prioritizeWorkflows([{ ...row, action: "TEST_PLAN", budgetMinor: null }])[0].priority.level, "blocked");
});

test("agent credential binds role, market and scope, and strict input cannot supply permissions or budget", () => {
  const secret = randomBytes(32).toString("base64url");
  const tokenSha256 = createHash("sha256").update(secret).digest("hex");
  const binding = { id: "test-catalog-worker", staffId: "fixture-staff", role: "MERCHANDISER", markets: ["bd"], scope: "test", tokenSha256 };
  const config = JSON.stringify([binding]);
  const agent = authenticateWorkflowAgent(secret, config);
  assert.ok(agent);
  assert.equal(agent.role, "MERCHANDISER");
  assert.equal(Object.hasOwn(agent, "tokenSha256"), false);
  const request = workflowAgentRequest.parse({ mode: "preview", marketId: "bd", scope: "test", action: "HOME_DRAFT", draftId: "a".repeat(64) });
  assert.equal(canProposeWorkflow(agent, request), true);
  assert.equal(canProposeWorkflow(agent, { ...request, marketId: "us" }), false);
  assert.equal(canProposeWorkflow(agent, { ...request, scope: "live" }), false);
  assert.equal(canProposeWorkflow(agent, { ...request, action: "PURCHASE_PROPOSAL" }), false);
  assert.equal(workflowAgentRequest.safeParse({ ...request, action: "HOME_PUBLISH" }).success, false);
  assert.equal(workflowAgentRequest.safeParse({ ...request, marketId: "unknown" }).success, false);
  for (const changes of [{ ownerId: "other-staff" }, { role: "MANAGER" }, { budget: 90_000 }, { mode: "execute" }]) {
    assert.equal(workflowAgentRequest.safeParse({ ...request, ...changes }).success, false);
  }
  assert.equal(configuredWorkflowAgents(JSON.stringify([binding, { ...binding, id: "duplicate-digest" }])).state, "invalid");
  assert.equal(authenticateWorkflowAgent(randomBytes(32).toString("base64url"), config), null);
});
