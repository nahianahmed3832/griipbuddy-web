# Workflow manager and delegated agents

The staff queue uses a deterministic review order. Benefit and confidence increase priority and higher effort lowers it. Available stock informs merchandising, experiments and replenishment. All requested commitments are considered against the relevant market, evidence scope, ledger and currency. The queue records when stock or budget evidence is missing. An unscored field uses a conservative display default and stays labeled unscored. Queue scores express review order and do not measure causal lift or supply execution authority.

## Proposal interface

An approved employee runner can call `POST /api/staff/workflows/agent` with the `x-griip-workflow-token` header. Configure the server-owned JSON array `GRIIP_WORKFLOW_AGENTS` through the runtime secret store. Each entry includes `id`, `staffId`, `role`, `markets`, `scope` (`test` or `live`), and `tokenSha256`. Use an independently generated random 32-byte base64url token per binding. The server stores only its lowercase SHA-256 digest. Give the runner its token in its separate secret store. The `staffId` must identify an active account with the existing reporting and action permissions for that market. Duplicate bindings and invalid configuration disable the bridge. Use a distinct test binding and a protected staging network for integration checks.

Each request contains `mode` (`preview` or `propose`), `marketId`, `scope`, `draftId` (a saved Product Intelligence draft), and `action`. The API compiles the action with the same evidence intake as the staff interface. It reloads the exact saved market scope and current staff access. `preview` checks applicable stock, price and fulfillment evidence and creates no workflow or job. `propose` may create a draft with the delegated identity and backing staff account recorded in the audit history. The response includes `executed: false`. Execution, queueing, budget changes and decisions use the separate policy-controlled staff engine.

| Role | Proposals supported | Optional action parameters |
| --- | --- | --- |
| `MERCHANDISER` | `HOME_DRAFT` | `ranking: "recommended"` proposes a fallback lineup. Omitting it proposes a collection. |
| `BUYER` | `PURCHASE_PROPOSAL` | The procurement quote supplies local currency, amount, physical pool and recorded constraints. |
| `RESEARCHER` | `TEST_PLAN` | `durationDays`, `minimumStock`, `successMetric` and `successThreshold`. Test spending requires separate recorded authority. |
| `ANALYST` | `CONVERSION_TASK` | `area` (`funnel`, `payment` or `search`). Facts and uncertainty use the scoped saved draft. |
| `LISTING_EDITOR` | `LISTING_DRAFT` | Provide `listingName` or `shortDescription` as bounded plain-text suggestions. Existing facts remain the review source. |
| `MANAGER` | `TEST_PLAN`, `CONVERSION_TASK` | Same typed fields as the specialist proposal. |

The existing storefront catalog candidate review remains the provider-assisted listing workflow. When its private runner is enabled and configured, a listing workflow can link a current candidate for the same product and market. The existing runner controls its model quota and review. Stage 5 creates no separate AI API call. Imported supplier prose, listing suggestions and search strings stay evidence or draft content. They cannot select permissions, tools or budget limits.

By default workflow prioritization and dry-runs work with deterministic data. The employee endpoint needs explicit credentials and policy configuration. The existing listing runner also needs its original private network, approved provider and catalog candidate. Verify those connections separately before describing them as operational.
