# Legacy checkout outcome bridge

The managed storefront reports authoritative outcomes from its native orders and from authenticated external adapters. The legacy Bangladesh adapter exports explicitly enrolled fixture orders from a dedicated MongoDB replica. The storefront imports the signed export into its own measurement tables. The legacy checkout remains the system of record for those orders.

## Evidence and reconciliation

| Event | Source evidence |
| --- | --- |
| Order accepted | Committed COD checkout, immutable acceptance journal, saved currency and original quote |
| Order delivered | Committed delivery tracking evidence for the fulfilled shipment |
| COD collected | Matching successful payment ledger transaction for the order and its booked amount |
| COD remitted | Verified carrier reconciliation rows and settlement evidence from a batch that can be assigned to exactly one order. Gross less supported deductions must equal net remittance. |

The source exports the supported prefix of these transitions. A later export can add a newly verified transition. Delivery leaves COD uncollected until the authoritative cash receipt exists. Collection leaves remittance pending until matched settlement evidence exists. Historical orders with insufficient evidence remain outside the bridge.

Each batch uses the version 1 schema, a configured authority and market, and the original currency. The importer authenticates the exact bytes with HMAC, enforces chronology and amount reconciliation, and uses stable identities for the booking and each event. Exact replay adds zero rows. A conflicting lifecycle or booking rejects the batch. The payload carries no contact details or addresses.

For a consented checkout, the storefront can issue a short-lived, one-use proof bound to the verified cart and market. The legacy service records the validated proof only on the committed order. The importer links it to the actual measured session when consent still permits the association. Withdrawal removes the linkage and preserves the authoritative order outcomes.

## Staging operator workflow

1. Apply the storefront Prisma migrations. Enable the importer in the isolated review profile with `GRIIP_OUTCOME_BRIDGE_ENABLED=1`, `GRIIP_OUTCOME_BRIDGE_AUTHORITY=legacy-checkout`, and `GRIIP_OUTCOME_BRIDGE_MARKET=bd`. Supply the same private `GRIIP_OUTCOME_BRIDGE_SECRET` to the legacy exporter and storefront importer. For the optional consent link, supply a distinct `GRIIP_OUTCOME_HANDOFF_SECRET` to both applications and the importer.
2. Run `backend/recovery/outcome-bridge.cjs` with `GRIIP_OUTCOME_BRIDGE_FIXTURE=1`, `GRIIP_OPERATIONS_MODE=staging`, the `griipbuddy_catalog_outcome_bridge_stage` MongoDB database on the `griip-bridge` replica set, and fixture Redis. Keep the source on a private network. The `seed` and `serve` commands set up the synthetic catalog and checkout service. A separate storefront validation profile can use `GRIIP_OUTCOME_BRIDGE_USE_LEGACY_CHECKOUT=1` to reach the internal `outcome-legacy-api:38100` service. Run `tsx scripts/seed-outcome-bridge-stage.ts` to mirror the synthetic SKU into that review database.
3. Run `resolve <checkout-attempt-id>` on the legacy runner to look up its committed source order. Export it using `export <source-order-id>`. Pass the signed output to `tsx scripts/import-outcome-bridge.ts` via private stdin. The first line is the hex signature and the remainder is the exact JSON body. Keep the transport private.
4. In staging, the legacy runner can exercise simulated delivery, cash collection, and remittance with `deliver`, `collect`, and `remit`. These commands use the existing fulfillment, payment, and reconciliation writers. Repeat the authenticated export after each transition when verifying incremental reporting.
5. Open **Staff → Acquisition**, choose **Bangladesh** and **Test only**, and check **External checkout outcomes** and **Event debugging**. Aggregate market metrics include the imported outcomes, and the bridge panel identifies their contribution. Compare the booking and subsequent events against the signed export. Check the US and live views for isolation.

## Marketplace development report check

Use a fresh fixture authority and signing key for each rehearsal. The legacy runner's `rehearse YYYY-MM-DD` command requires a disposable loopback MongoDB replica and Redis, an authority named `legacy-checkout-dev-<run-id>`, and a recent Dhaka fixture day. It runs the existing booking, delivery, collection, and remittance writers under a synthetic clock and exports those saved facts. Pick a fixture day outside the finance review window.

Run the storefront CLI through a one-off operator on the dedicated Marketplace development database network. Its environment must match the exact `/marketplace` development profile, including `NEXT_PUBLIC_STOREFRONT_BASE_PATH=/marketplace` and `GRIIP_DEVELOPMENT_ACCEPTANCE=1`. Pass the bridge flag, market, fresh authority, and signing key to that operator only. Keep `GRIIP_OUTCOME_BRIDGE_USE_LEGACY_CHECKOUT=0`. This profile imports report fixtures without a shopper link. The application continues its native checkout path.

```sh
tsx scripts/import-outcome-bridge.ts import < outcome.signed
tsx scripts/import-outcome-bridge.ts import < outcome.signed
tsx scripts/import-outcome-bridge.ts verify < outcome.signed > receipt.json
node scripts/check-outcome-bridge-stage.mjs development-report receipt.json
```

Keep the *signed* input and signing key private. The `verify` command reads back the persisted records and emits a separate receipt containing the fixture day, market, currency, amounts, and hashed event references. The browser check requires `GRIIP_DEV_EXPECTED_REVISION` and existing development staff credentials in the environment. It checks each reference once in the dated Bangladesh test report and verifies its absence from the US and live report scopes. For one fresh completed fixture, the first import reports one new order and four new outcomes. Exact replay adds zero records. A modified signature or a valid export supplied with the wrong authority or market is rejected.

## Carrier evidence required for provider verification

- A provider-approved development account or sandbox and credentials scoped to its test consignments. Capture one sample each for delivery, refusal, and return with a provider order or consignment ID, tracking reference, provider event ID, event timestamp, and status.
- An order-linked cash collection receipt with original currency, gross collected, collection reference, and occurrence time. Delivery status and COD due remain separate.
- A settlement statement with an order or consignment reference, settlement batch and payout IDs, dates, currency, gross, deduction line items, net, and deposit evidence. The current adapter reconciles complete batches assigned to one order. Shared payouts require reliable line-level allocation. Steadfast describes merchant reporting and payouts in the business portal. [Steadfast business services](https://steadfast.com.bd/index.php/business).

The importer and exporter are restricted to fixture environments. Production rollout requires a reviewed external authority and access, a way to establish complete order-linked settlement evidence from actual provider records, and separately authorized deployment and enrollment.
