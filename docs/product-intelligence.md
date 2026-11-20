# Product Intelligence

Open **Staff → Product Intelligence** and choose a market and a data scope. The overview uses closed days on that market’s calendar. Start with 28 days or choose a shorter window and a catalog product ID. The production view excludes known staff, test, and classified bot activity. Historical bot tagging is incomplete. Test evidence stays in the staging and test scope.

## Evidence and reconciliation

| Dataset | Authoritative records and limitations |
| --- | --- |
| Acquisition and search | Versioned first-party events. Visible product impressions use the existing foreground visibility rule. Unique viewers and searchers deduplicate by consented journey. Search labels require repeat searches and privacy filtering. Reformulations are changes within a short observed search sequence in one tab session. Coverage depends on consent and the 30-day event retention window. |
| Conversion | Product-level checkout is linked through the recorded cart and shopper session. Funnel values show steps observed after a product view. Verified capture and COD collection remain separate from an accepted order and matched carrier remittance. |
| Commerce | Native orders and validated legacy outcomes, deduplicated by stable event IDs. Missing product mappings remain at market level. Only verified provider evidence counts as a payment failure. Verified returns require line quantities to contribute units to product-level totals. |
| Availability and price | Scheduled market offers and physical stock snapshots. Closed-day classifications preserve unknown and partly available days. A market delivery indicator describes the configured service coverage. Checkout still checks the shopper’s exact destination. |
| Costs | Existing dated contribution records and exact allocations. When shared fees, returns, acquisition costs or product expenses cannot be allocated, the product report shows unavailable inputs. It never fills them with zero. |
| Campaigns, ads, trends and suppliers | Consented onsite campaign labels provide source context. Offsite impressions, platform attribution, spend and external trends need a verified feed and a market/product mapping. Legacy purchasing records do not yet have a verified stock and supplier mapping into the storefront. |

The consolidated overview keeps BDT and USD separate. The existing `GRIIP_REPORTING_FX` rate sheet can convert verified collections when the selected windows match and every source has a dated rate. The overview shows the currency, rate date, source and rounding method.

## Workflows and permissions

Staff need reporting access to the selected market for metrics, forecasts and the analyst. Saving collection or product-test drafts also requires merchandising access. Purchasing drafts require operations access. Drafts contain an immutable evidence snapshot and can take dated, staff-reported follow-up observations. These are planning records. Catalog publication, supplier communication, and purchases stay in their existing operating workflows.

The [assessment and analyst methodology](product-intelligence-assessments.md) defines confidence and opportunity thresholds. Missing LLM credentials leave the deterministic analyst available. Any configured LLM receives only bounded rule identifiers, samples, and market/date context. Shopper questions, supplier prose, search terms, and customer records stay local to the storefront.

The [forecast and purchasing methodology](intelligence-forecast.md) describes horizons, rolling comparisons, stockout treatment, analogue criteria, and the approved operator input fields. Supplier terms, incoming dates, constrained stock, budget, and costs must be verified before a proposed quantity can be used.

## Observation job

Apply the Product Intelligence migrations and use the existing dedicated runtime database and market profile. Give the scheduled service role permission to read market catalog and checkout coverage and insert `ProductIntelligenceSnapshot` rows. This job uses the same Node, Prisma schema, and generated client as the storefront.

Run `npx tsx scripts/observe-product-intelligence.ts` every hour, or pass one market ID when scheduling countries separately. It observes every configured operating market by default. Choose one scheduler for an environment, serialize overlapping invocations, and alert on nonzero exit. The unique market, variant, evidence scope and UTC hour key makes a retry idempotent. Use the deployment secret store for `DATABASE_URL` and the existing market profile. This example runs an environment-loaded release wrapper in a UTC scheduler.

```cron
7 * * * * /opt/griipbuddy/bin/storefront-job observe-product-intelligence
```

The wrapper runs `./node_modules/.bin/tsx scripts/observe-product-intelligence.ts` in the deployed storefront tree. The job only samples observed state. Do not use the current stock value to fabricate historical availability. Run the staging-only `npx tsx scripts/seed-intelligence-review.ts` after the existing market review fixtures and migrations to demonstrate both markets. That script refuses production and writes explicitly labelled test observations and orders.

## Staging evidence

The protected review uses 165 closed days of fixture records from June 6 through November 17, 2026. The primary product reports for October 21 through November 17 each reconciled 46 booked units, 46 collected units, and seven remittances to the staging order and payment records. Cost evidence is deliberately absent for the two primary variants. The notebook fixture covers the complete-cost path.

| Fixture and series | Seven-day booked units and 80% range | Scored holdouts | Recent mean MAE | Weekly seasonal naïve MAE | Draft replenishment |
| --- | --- | --- | --- | --- | --- |
| Bangladesh · Dome Table Lamp · Cream | 11 units, 11–11 | 7 | 0.30 units | 0.00 units | 12 units, BDT 11,400 |
| United States · Pocket Bluetooth Speaker · Charcoal | 11 units, 11–11 | 6 | 0.30 units | 0.00 units | 10 units, USD 135 |

The fixture bookings repeat a synthetic weekly pattern. These results demonstrate the backtest and proposal calculations without establishing forecast accuracy or operational readiness on live orders. The test scope separates them from production evidence. Shared pools with incomplete operational inputs remain in investigation and do not produce quantities.

The protected release `c5af73cc782183ec` passed the Bangladesh desktop and US 320 px review. The mobile review expanded cost and backtest details and changed the variant horizon without losing the selected variant. The release also verified the deterministic analyst, separate-currency overview, sparse-stock history, and a saved fixture purchasing proposal. The scoped staff browser tests separately verified that reporting-only staff could read their granted market and were denied draft writes and access to other markets. An owner saved a product-test draft and a dated follow-up in the isolated database. The hourly observation job was run and retried within the same slot. The retry inserted zero rows in both markets.
