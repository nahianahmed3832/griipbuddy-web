# Multi-market staging review

The storefront serves both markets from the same application and database schema. The market selector chooses sellable offers, currency, checkout coverage, and reporting scope. Language changes separately. Server and infrastructure location are deployment choices. Use the [market configuration guide](markets.md) for the validated settings and permission controls.

## Review profiles

| Market | Staged configuration | Requirements before production |
| --- | --- | --- |
| Bangladesh | BDT, en-BD, Asia/Dhaka, district-based checkout, Dhaka and Chattogram fixture delivery, market-owned stock and COD. SSLCOMMERZ is a sandbox adapter. | Confirm local price and tax rules, coverage and carrier accounts, COD collection and statement reconciliation, returns operations, and historical cost inputs. A legacy checkout deployment needs its own verified outcome source and a consented cross-site correlation contract. |
| United States | USD, en-US with an es-US homepage override, America/New_York, state and ZIP validation, New York fixture ground and express service, independent stock and fixture COD. PayPal can quote in preview and supports sandbox capture with credentials. | Confirm local offers and stock, quote and tax authority, prepaid provider and callback credentials, supported states and services, fulfillment and returns operations, and financial evidence. Fixture COD illustrates the configurable workflow. |

Explicit market URLs use `/?market=bd` and `/?market=us`. The Spanish homepage override uses `/?market=us&lang=es-US`. Staff can review global and market homepage releases at `/staff/homepage`. The market comparison is at `/staff/acquisition?market=all&scope=test`. Staff access depends on the assigned permissions.

The [review profile](../deploy/market-review-profile.json) enables independent market inventory and a US fixture checkout. On the isolated staging database, apply Prisma migrations, seed the demo catalog, create the staging owner, then run `npx tsx scripts/seed-market-review.ts`. The script requires `GRIIP_MARKET_REVIEW_FIXTURES=1` and the dedicated staging database identity. Use sample contact and shipment details during checkout.

## Measurement and finance

The [versioned event schema](../src/lib/measurement/schema.ts) is shared. Browser ingestion verifies the selected market and its analytics configuration. Checkout joins use the committed attempt's market and the consented session. Outcome adapters derive booking, payment, parcel, collection, and return events from committed sources. Each event carries its provider or lifecycle source and evidence classification. Review synthetic checkout, sandbox provider evidence, and production records in their designated dataset.

Acquisition dates use the market's local calendar and preserve original currency. The cross-market view shows amounts side by side. Set `GRIIP_REPORTING_FX` to an approved rate sheet only when a consolidated amount is required. It contains `currency`, ISO closing date `asOf`, provenance `source`, and a `rates` object mapping each source currency to a positive decimal string in target major units per source major unit. The report requires matching calendar date labels and a rate for every foreign currency. It rounds each converted market subtotal half up to the target minor unit before adding it.

`GRIIP_REPORTING_FX_TEST` uses the same format and applies only to test reports. Label synthetic rates as fixtures in `source`. Use a dated approved sheet in `GRIIP_REPORTING_FX` for live reporting.

Contribution profit requires dated order-level evidence from the reconciled finance ledger. Each record specifies original currency, recognized revenue excluding tax, refunds excluding tax, item cost, packaging, outbound fulfillment, return fulfillment, and payment fees. Explicit confirmed zeroes are valid. Missing fields, records that predate the last order update or measured outcome, and currency mismatches make the period's contribution profit unavailable. Finance import and local cost backfill are rollout inputs.

The forecast summarizes four completed weeks of classified order bookings in that market, with at least 20 observations. It shows the historical range and the last-week holdout error. Homepage recommendations use eligible products in the same market. Bestseller and trending sections use the thresholds documented in the merchandising guide or fall back to curated items.

## Personalization and experiment review

The market review deployment `45031f55b24c18d5` used a separate recommendation policy per market and the isolated experiment flag. The hosted checks exercised the control and personalized experiences in Bangladesh at 1360 px and in the US at 320 px. They verified visible-card exposure, market round trips, preserved assignment after sign-in, reset and disable, private responses, editorial fallback, and authenticated preview and results pages.

One hosted fixture checkout in each market was linked to its assignment and a single exposure. Bangladesh fixture `GB-2CF8AEC5CBC7` used BDT and Standard delivery. US fixture `GB-60AE99F0C0EB` used USD and fixture ground delivery. The staging order records reconciled booking, delivery, COD collection, and remittance. Hosted conversion and fulfillment cohorts remain inside the planned follow-up windows. Isolated database tests separately covered mature Bangladesh bridge COD and US sandbox capture and failure evidence.

Open `/staff/homepage?scope=bd%3Adefault` or `/staff/homepage?scope=us%3Adefault` for policy controls. View market results at `/staff/acquisition/experiments?market=bd&scope=test` or `/staff/acquisition/experiments?market=us&scope=test`. Scope, maturity, cost inputs, and the production enrollment guard are described in the [experiment plan](recommendation-experiment.md).

## Replay

Set `ACQUISITION_MEASUREMENT=1` for the structured collector. Clarity looks for `CLARITY_PROJECT_ID_BD` or `CLARITY_PROJECT_ID_US` with an optional shared project fallback. The market's analytics configuration can disable replay. Replay has a separate opt-in per market, denies ad storage, masks public-page content, and uses a separate document boundary for sensitive routes. Enable Consent Mode and Strict masking on each QA project. Verify the hosted recording, market and page tags, withdrawal, and mobile performance with a configured QA account. [Microsoft Clarity consent](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2) · [Masking](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking).
