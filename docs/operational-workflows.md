# Operational workflows

Open **Staff → Workflow Center**. Choose a market and evidence scope, then open a saved Product Intelligence insight or select **Start workflow from this insight** in its draft history. The detail page records the proposal, owner, employee role when present, source window, uncertainty, policy version, budgets, execution attempts, and outcome-review date.

| Workflow | Executed action and evidence |
| --- | --- |
| Homepage merchandising | Validate current local offers, stock, seller permission and delivery. Create an editable draft or ranking change in the existing Homepage editor. Preview and schedule through that editor. Publication is separately governed and keeps the previous release for reversal. A newer revision blocks a stale publish or rollback. |
| Purchasing | Recalculate a saved variant-level proposal against the calibrated forecast, physical pool, verified stock, incoming goods, and dated supplier terms. Reserve the exact cost in the authorized ledger. A completed proposal holds its reservation until release or expiry. The internal result records zero spend and no supplier submission. |
| Product and category tests | Save a plan with a market audience, candidate products, stock threshold, budget, duration, metric, and stop rule. Execution prepares the plan and its reservation. A connected launch and attributed settlement are required to evaluate sales. |
| Conversion investigations | Record existing evidence and distinguish observed facts from hypotheses. Link an executed same-market homepage publication or rollback as a verified correction. Follow-up uses complete local days and the predetermined metric. Payment, search and Clarity evidence can guide investigation. A provider or search change requires an authoritative action mapping before its impact can be attributed. |
| Listing improvements | Save a bounded proposed title or description for existing merchandise. Use the existing private listing workforce tool in an authorized candidate when configured. Publication continues in the catalog workflow. |

## Scope, policies and budgets

Set `GRIIP_WORKFLOW_POLICY` in the runtime and the worker environment. Each entry binds `marketId`, `test`, `role`, `action`, `mode`, `version`, optionally `maxAttempts` (1–5), and optionally `maxRunsPerDay` (defaults to 20). Modes are `RECOMMENDATION_ONLY`, `DRAFT_ONLY`, `AUTOMATIC`, and `REVIEW`. The defaults allow staff planning and leave agent execution unavailable. Staff permissions are checked separately from policy. Agents use the [typed proposal bridge](workflow-agents.md), which accepts no execution or policy changes.

The daily cap is per market-local day, role, action, and evidence scope. A job at the cap moves to the next local day if its evidence is still current. Job claims use a 90-second lease. Each database mutation and execution receipt commit together. Expired claims recover through the scheduler, and transient failures retry with bounded backoff. A dry run checks authority, current eligibility, active resource reservations, and remaining budget without a committed action.

Purchase and test policy entries need a dated budget with `ledgerKey`, `currency`, `limitMinor`, `automaticLimitMinor`, and `validThrough`. Use the existing local procurement currency. The backend locks the ledger and physical resource before a commitment. An amount over the automatic limit can be sent for a decision if it fits the overall cap. An amount with no budget authority stays blocked. You can inspect commitments and recorded spending by currency in the Workflow Center. Explicit FX configuration and a dated reporting method would be required before showing a combined amount.

## Scheduled worker

Apply migration `202611180029_operational_workflows`. Install the existing operator dependencies, generate the Prisma client, and give the runtime role access to the workflow and authorized source tables. Use the same market profile and policy version for the web application and operator environment. The worker accepts the isolated `--test` scope or the verified `--production` environment. An optional market argument limits one run.

```sh
./node_modules/.bin/tsx scripts/run-operational-workflows.ts --test
```

Run the command from the configured operator release every minute. Each invocation sweeps expired work, processes at most 12 available attempts, and evaluates at most 12 due outcomes. Staff queue submissions also request a bounded immediate dispatch. The scheduled invocation provides recovery after a restart or a delayed retry. Use the existing operator secret store and monitor job failures. Provision recurring production scheduling only against the authorized production profile.

## Outcome review

Outcome labels apply to the predeclared criteria and reference the underlying reports. The homepage evaluator measures visible product impressions on the exact released configuration before the review cutoff. For a matching recommendation treatment it links the existing experiment and flags outstanding collection, delivery, and return windows. An experiment with mismatched configuration or inadequate evidence does not support a causal result. Internal purchasing proposals, test plans, and listing changes remain inconclusive for commercial outcomes until the authoritative execution and follow-up evidence is connected.

## Protected staging verification

- Bangladesh fixture `7c1053a9-23be-4b54-8e1b-b6639b8cebf7` used a saved lamp insight to create and publish a homepage collection. Two workers competed for each queued job and exactly one claimed it. A consented browser produced one visible BDT impression on the exact released configuration. The review met its one-impression reach criterion and kept `causal` false. Rollback `a787c5bd-3e7a-4b20-8dc4-483f7e08c42e` restored the previous inherited homepage.
- US fixture `e47d0701-4185-418c-b36d-f7ef09f9bff9` recalculated 10 eligible units and held USD 135.00 after the quote crossed the USD 100.00 automatic threshold. Recorded spend was zero. The proposal stayed an internal record.
- The staging policies resolved BDT with COD, sandbox SSLCOMMERZ, and standard delivery in Bangladesh. The US resolved USD with COD, sandbox PayPal, and fixture ground/express delivery. The review did not submit a supplier order or launch a campaign.
- The worker command ran against the staging queue. Isolated database tests covered duplicate requests, concurrent claims, market and agent permissions, competing commitments, daily caps, stale evidence, lease recovery, bounded retries, exact-release review, and audit deduplication.
- Protected release `274804d932594a09` passed the cross-market Workflow Center review, including USD budget details at 320 px and an authorized conversion investigation queued from a saved insight in the browser. The Bangladesh storefront showed its restored inherited homepage after rollback. The build, 50 unit tests, and nine focused PostgreSQL integration tests passed.
