# Marketplace development release

The current Next.js implementation runs in the existing Marketplace development slot at `https://dev.griipbuddy.com/marketplace`. The app serves its shopping, checkout, staff, measurement, intelligence, and workflow APIs in the same runtime. PostgreSQL database `griipbuddy_marketplace_dev` and its Docker network are dedicated to this slot. The root development storefront and legacy API have independent releases and database histories.

Before an update, compare the applied Prisma migration names and checksums with the candidate. Rehearse pending migrations on a restored copy. The root development database currently has a divergent migration history. Use the Marketplace installer for this source tree.

## Configuration and deployment

The existing host stores `DATABASE_URL`, `BETTER_AUTH_SECRET`, `SHOPPER_AUTH_SECRET`, `CHECKOUT_SECRET` and database role passwords in its restricted `app.env` and `compose.env`. The Marketplace app uses `COMMERCE_MODE=staging`, `GRIIP_MARKETPLACE_PREVIEW=1`, `BETTER_AUTH_URL=https://dev.griipbuddy.com`, and build prefix `NEXT_PUBLIC_STOREFRONT_BASE_PATH=/marketplace`. The exact Marketplace database, origin and prefix gate `GRIIP_DEVELOPMENT_ACCEPTANCE`. App cookies and client measurement state are scoped to the prefix. Catalog media, queue records, and test data are in the Marketplace database. The app uses PostgreSQL jobs, with no external queue shared across environments.

Runtime overrides are stored in the active release's mode-0600 `development.env`. Use `GRIIP_MARKET_CONFIGURATION` for market locales, currencies, inventory, and eligible methods. Use `GRIIP_WORKFLOW_POLICY` for test-scope budget and daily limits, `ACQUISITION_MEASUREMENT` and `GRIIP_RECOMMENDATION_EXPERIMENT` for test measurement and assignments, and `GRIIP_MEASUREMENT_RETENTION_EXTERNAL` when the host worker owns pruning. Set `MARKETPLACE_TEST_INTAKE_OPEN` only for the isolated test slot. Keep `BD_CHECKOUT_HANDOFF=0` during development acceptance. External supplier, campaign, email, and provider actions require their own authorized sandbox configuration.

Optional payment credentials are `MARKETPLACE_PAYPAL_SANDBOX_CLIENT_ID`, `MARKETPLACE_PAYPAL_SANDBOX_CLIENT_SECRET`, `MARKETPLACE_PAYPAL_SANDBOX_WEBHOOK_ID`, `MARKETPLACE_SSLCOMMERZ_STORE_ID`, and `MARKETPLACE_SSLCOMMERZ_STORE_PASSWORD`. The callback routes are `/marketplace/api/checkout/paypal/webhook` and `/marketplace/api/checkout/prepaid/callback`. Keep provider credentials dedicated to development. Use `CLARITY_PROJECT_ID_BD` and `CLARITY_PROJECT_ID_US` only for verified QA projects. The intelligence provider uses `PRODUCT_INTELLIGENCE_ANALYST_PROVIDER`, `PRODUCT_INTELLIGENCE_ANALYST_MODEL`, and `PRODUCT_INTELLIGENCE_ANALYST_API_KEY`. Delegated workflow agents use `GRIIP_WORKFLOW_AGENTS` and the policy limits in the [agent runbook](workflow-agents.md). Deterministic workflows and analytics remain available with provider credentials absent.

`deploy/install-marketplace.sh` acquires the existing deployment lock and writes a checksum-verified, restorable PostgreSQL dump before invoking Prisma once. For an existing environment use `MARKETPLACE_UPDATE_ONLY=1` to skip catalog and checkout fixture updates. On a low-space host, prebuild the exact committed archive and base-path runtime elsewhere, label its image with `org.opencontainers.image.revision`, and supply `MARKETPLACE_PREBUILT=1` and `MARKETPLACE_SOURCE_SHA`. The installer validates the image label and HTTPS health before updating `current`. Store credentials outside the Git archive using the existing host environment files.

When packaging a prebuilt standalone runtime, preserve the generated module aliases under `.next/node_modules` and install the runtime dependencies for the host operating system. Check that the Prisma alias resolves inside the candidate image before replacing the running application. If a candidate fails after migrations, the retry can use `MARKETPLACE_RESUME_BACKUP` with its validated pre-migration dump. The installer then verifies Prisma status before activation.

## Monitoring and rollback

Check `/marketplace/api/health` and run `deploy/check-marketplace-edge.sh` for the scoped HTTPS and POST route checks. The application logs are under `docker logs griipbuddy-marketplace-dev-app-1`. Workflow attempts and report failures are visible in Staff → Workflow Center and Staff → Acquisition. The host worker logs go to `journalctl -u griipbuddy-marketplace-dev-jobs.service`. The timer and host lock keep scheduling independent of application replica count.

The installer records the previous release, database dump, and any edge configuration backup. For rollback, run Compose against the previous release directory and its `APP_REVISION`, restore its acceptance environment if present, and repoint the `current` symlink after the previous app passes HTTPS health. Restore the matching nginx backup with `nginx -t` before reload if method rules require reversal. Disable the development timer if rolling back to a release without its runner. A container rollback leaves applied SQL migrations in place. If the previous binary is incompatible with the migrated data, use the dump to restore to a separate database first and reconcile post-release writes before any authorized restore of the operating database.

## 2026-11-18 development release

| Item | Verified value |
| --- | --- |
| Source | `codex/development-marketplace-20261118` at `7a8b1652a48b408b7001577b7ef4223f85698a53` |
| Healthy runtime | `81f9b2b32fdb8aac128d` with test-only order intake |
| Previous runtime | `96b8d1c5f3a5fd54e73d` at `404b3e84a3e1a0782b9de7ac90fae874648dcf70` |
| Pre-migration dump | `/opt/griipbuddy-marketplace-dev/backups/20261118T130723Z-51290a6208a8b7f30e99.dump` |
| Database | All 39 migration names and checksums verified. The 27 pending migrations were rehearsed against a restored copy before application. |
| Scheduled jobs | One host timer verified. Its first invocation completed workflow, stock observation and retention jobs. The next invocation skipped stock observation and retention already completed within their current intervals. |

The original Marketplace binary, `51290a6208a8b7f30e99`, was restored and passed health after the first candidate failed to load its Prisma alias. The retry used the verified pre-migration dump and checked migration status before activating the corrected package. The subsequent release applies the same eligibility rule to navigation, collections and homepage imagery. Both market browser checks passed without failed image requests. The original BDT asset still responds only within its eligible scope. Check disk capacity before the next update. The development host had about 231 MiB free after activation.

The final candidate passed lint, typechecking, a production build, 50 unit checks and 61 PostgreSQL integration checks. On the hosted site, blocking the measurement and recommendation endpoints in browser tests still allowed both markets to open the fixture product, use the cart and reach checkout. The HTTPS checks verified the scoped edge write routes and protected staff entry points.

### Acceptance results

| Market | Hosted commerce evidence | Staff report |
| --- | --- | --- |
| Bangladesh | `en-BD`, BDT, Dhaka fixture address and standard delivery. Saved COD order through delivery, BDT 1,210.00 collected, BDT 1,209.89 remitted, return and restock. | [Bangladesh test acquisition](https://dev.griipbuddy.com/marketplace/staff/acquisition?market=bd&scope=test) |
| United States | `en-US` checkout, `es-US` storefront, USD, US postal validation, fixture ground and express options. Saved COD order through delivery, USD 26.63 collected, USD 26.52 remitted, return and restock. | [US test acquisition](https://dev.griipbuddy.com/marketplace/staff/acquisition?market=us&scope=test) |

The hosted journeys verified visible exposure, zero-result and filtered search, shopper association, cart and checkout, submitted-order recovery, duplicate retries, and the six backend outcome references per order. A Bangladesh shopper added and removed one wishlist item, with one event per action and the order count unchanged. Test outcomes were absent from live views. The combined report kept BDT and USD separate and showed missing costs and FX conversion. Manual fulfillment, collection, remittance, and returns are fixture evidence.

Staff used eight labeled search journeys in each market to test the evidence-backed analyst. The hosted fallback returned evidence with market-specific currency and scope. A Bangladesh homepage workflow handled a scheduled draft, checked the start and end in Dhaka time, published the specified release, recorded a verified visible product exposure, and rolled back. The US never displayed the Bangladesh draft. After the review window elapsed, the evaluator recorded one visible impression against the target of one and marked the result observational. A budgeted development workflow rejected an over-budget proposal, deduplicated submission, allowed one execution attempt, and released its BDT commitment with zero recorded spend. The Bangladesh-restricted staff account could view Bangladesh material, and the analyst denied its US request.

[Homepage editor](https://dev.griipbuddy.com/marketplace/staff/homepage?scope=bd%3Aen-BD) · [Workflow review](https://dev.griipbuddy.com/marketplace/staff/workflows/a78bc53a-cd37-4c98-add0-d8f50dd888f0) · [Intelligence](https://dev.griipbuddy.com/marketplace/staff/intelligence?market=bd&scope=test) · [Experiments](https://dev.griipbuddy.com/marketplace/staff/acquisition/experiments?market=bd&scope=test)

Both markets exercised control and personalized assignments, visible exposures and repeat exposure requests. US behavioral recommendations used a consented cart event, while a lone view fell back to the editorial lineup. Anonymous browsers could not see another shopper's results, and simulated recommendation failure still displayed editorial content. The temporary market overrides were restored to inheritance. The hosted experiment reports show local currency, guardrails, pending windows and insufficient mature data for a decision.

The 390 px browser checks verified public-page masking, private-route replay exclusions, separate personalization choice, and withdrawal with invalidation of a prior measurement token. Sample page loads varied across the public network. Live Clarity recording review requires development project IDs and project access. Provider-backed payment, fulfillment and analyst runs require development credentials. The legacy checkout bridge remains disabled in this environment.

### Roll back the app-only release

On the development host, restore the previous Marketplace binary using the same dedicated database. The immediate prior binary uses the same schema and job runner.

```bash
(
set -euo pipefail
root=/opt/griipbuddy-marketplace-dev
release="$root/releases/96b8d1c5f3a5fd54e73d"
exec 9>"$root/deploy.lock"
flock -n 9
[[ $(readlink -f "$root/current") == "$root/releases/81f9b2b32fdb8aac128d" ]]
APP_REVISION="${release##*/}" MARKETPLACE_ACCEPTANCE_ENV="$release/development.env" \
  MARKETPLACE_FIRST_PARTY_ONLY=0 docker compose --env-file "$root/compose.env" \
  -f "$release/deploy/compose.marketplace.yaml" up -d --no-deps --wait --wait-timeout 90 app
health=$(curl --fail --silent --show-error --max-time 10 --resolve dev.griipbuddy.com:443:127.0.0.1 \
  https://dev.griipbuddy.com/marketplace/api/health)
[[ "$health" == *'"revision":"96b8d1c5f3a5fd54e73d"'* && "$health" == *'"database":"ok"'* ]]
printf '%s\n' "$health"
ln -s "$release" "$root/.rollback.$$"
mv -Tf "$root/.rollback.$$" "$root/current"
)
```

## Finance and provider preparation

The development operator can run `scripts/import-development-finance.ts` with a JSON ledger on stdin. It accepts `source` beginning with `fixture:` and an `orders` array. Each row needs `orderId`, `marketId`, `currency`, `verifiedThrough`, `revenueBeforeRefundsMinor`, `refundsMinor`, `itemCostMinor`, `packagingMinor`, `outboundMinor`, `returnMinor` and `paymentFeesMinor`. Supply `null` for an unverified amount and an explicit `0` only when supported by the ledger. The operator verifies the fixture belongs to this development database, matches the market and currency, and covers the last recorded outcome. An identical replay leaves the row unchanged. A conflicting row rejects the batch.

`GRIIP_REPORTING_FX_TEST` may supply a dated rate sheet for test reports only. `GRIIP_REPORTING_FX` is the approved rate sheet for live reporting. Both the acquisition and product intelligence views require matching market calendar windows. Product intelligence uses only complete local days. Source, closing date, reporting currency and the conversion method are shown with a consolidated result.

The development analyst requires a dedicated OpenAI project key, an approved structured-output model, and `PRODUCT_INTELLIGENCE_ANALYST_MAX_CALLS_PER_24H`. The server reserves a slot for each outbound attempt and returns deterministic evidence at the limit. Approval for a provider project and its spending controls is separate from this application limit.

## 2026-11-19 development follow-up

Marketplace revision `33377ac43d8e126b95c8` runs from commit `8a2a5ed9d966d8cda916e262ebc459168e157235`. The installer found all 39 migrations already applied. The fresh, checksum-verified backup is `/opt/griipbuddy-marketplace-dev/backups/20261118T162701Z-81f9b2b32fdb8aac128d.dump`. For an app rollback from this revision, use the same locked procedure above with current revision `33377ac43d8e126b95c8` and previous release `81f9b2b32fdb8aac128d`. The finance and bridge fixture rows remain in the development database after an app rollback.

- A signed legacy Bangladesh fixture yielded one booking, four outcome transitions and zero shopper associations. Exact replay created zero records. A tampered signature, wrong authority and wrong destination were rejected. The hosted staff report matched each event once, including BDT 880.00 collected and BDT 875.50 remitted, and excluded it from the US and live reports. The shared checkout continues to use its existing path. [Bangladesh bridge fixture](https://dev.griipbuddy.com/marketplace/staff/acquisition?market=bd&scope=test&view=events&from=2026-11-17&to=2026-11-17)
- Two previously verified native fixture orders received labeled finance evidence. The import rejected cross-market data atomically and conflicting evidence. Replaying the same ledger left both rows unchanged. The hosted test report showed fixture contribution of BDT 459.89 and USD 9.18, and consolidated fixture merchandise of USD 31.24. The test rate was absent in the live and wrong-date views. [Cross-market fixture report](https://dev.griipbuddy.com/marketplace/staff/acquisition?market=all&scope=test&from=2026-11-18&to=2026-11-18)
- Development allows 20 analyst explanation attempts per 24-hour quota window. An isolated concurrent test used a simulated provider to prove the cap, minimized payload and evidence fallback. A provider project key is still required for a hosted model call.
- Lint, typechecking, the production build, 52 unit tests and 62 PostgreSQL integration tests passed. The development app and database were healthy, and the enabled worker completed its scheduled run. The adjacent development root stayed on `94b92e89858f10e24aa1`.
- Two detached Marketplace builds were removed after their source archives and lack of dependencies were verified. The active and rollback images and existing backups were retained. After the new release and backup, the host had about 222 MiB free.
