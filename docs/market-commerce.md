# Market checkout and reconciliation

The market manifest selects the address, payment, fulfillment, and return adapters. Native COD uses the checkout policy, delivery zones, market offers, seller grants, and stock locations for the selected market. Browser checkout sends a requested destination. The server binds the saved attempt to the verified market, payment method, evidence class, and the commercial terms used to quote the order.

The commercial snapshot records the configuration and policy revisions, price list, currency, rounding and tax treatment, selected delivery service, and fulfillment and returns adapters. An order stores the actual amounts and purchased item snapshots separately. A revised price or policy requires new confirmation before a payment or stock allocation. Recovery checks the signed guest session and saved market.

## Current staging adapters

| Market | Address and delivery | Payment | Fulfillment and returns |
| --- | --- | --- | --- |
| Bangladesh | BDT, Bangladesh phone and district format, explicit market delivery services and merchandise tax | Native COD fixture and optional SSLCOMMERZ sandbox | Manual parcel or the existing configured test courier workflow, staff-recorded return receipt and refund approval |
| United States | USD, US phone and state/ZIP format, configured contiguous-US test shipping quote | Optional PayPal sandbox. Shared native COD can be exercised with an explicit USD policy and delivery fixture | Manual market stock location, dispatch, tracking, and item returns |

The fixture tests exercise a second configuration with manual US parcel fulfillment, a different tax rate, a USD COD payment, collection, matched remittance, and item return. The staging deployment can keep the default US PayPal test quote enabled and omit sandbox credentials. Payment initiation requires its configured provider credentials.

Native COD fixture orders carry `fixture` evidence in staging. Provider requests in staging use the provider sandbox and record `sandbox` payment evidence. Local provider mocks record `fixture`. Staff-recorded fulfillment and returns on test orders remain fixture evidence. Production orders require an active market, production adapters and intake, a valid policy, locally authorized stock, and configured delivery coverage. Historical records may have unknown evidence.

## Outcome adapter boundary

The versioned measurement projector uses committed order, payment, carrier, parcel and return records. Provider capture and failure evidence also checks the market and payment method on the saved attempt. COD booking, delivery, cash collected, and carrier remittance are separate transitions. A staff approval for a refund is a case step. A confirmed provider refund supplies the refund outcome.

The [legacy checkout outcome bridge](legacy-outcome-bridge.md) maps committed order, delivery, COD collection, and balanced remittance evidence into the versioned outcome contract in isolated staging. The importer validates authority, market, currency, chronology, and amount reconciliation, and deduplicates repeat exports. Production rollout requires verified provider evidence and separately authorized deployment.

The staff COD and coupon views scope totals, offers, expiry and actions to the selected market. Seller order lists, CSV exports and sample COD statements apply the market’s local date boundary and preserve its source currency. A seller’s prior order access uses the seller snapshot saved with the order. The sample statements use the existing fixture commission and exclude production orders.

## Live dependencies

- Bangladesh requires explicitly enabled production checkout and tax/delivery policies, local eligible stock, verified merchant terms, and live carrier and collection evidence. The legacy transfer requires the external outcome adapter described above.
- United States requires an approved tax calculation, delivery service and inventory coverage, and live payment and returns arrangements. The PayPal adapter in this storefront currently targets the sandbox.
- Production settlement and reporting require provider reconciliation and historical cost inputs. Confirm receipt and remittance from authority records before using them in reports.
