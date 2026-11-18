# Customer account MVP

The Bangladesh storefront provides Bangla and English account screens. United States staging uses English. Route the original Bangladesh storefront through `/bd` and pin US storefront links with `?market=us`. The country switch opens the target storefront as a document so the session shell, menus and checkout resolve the same market.

See [Global customer account](global-customer-account.md) for the global directory, distinct-origin staging handoff, Canada fixture and purchase-time return terms.

## Screens and routes

| Shopper entry point | Route | Source of truth |
| --- | --- | --- |
| My Account | `/bd/account` | Verified shopper session, current-market order and case |
| My Orders | `/bd/orders` | Authorized orders in the selected market, plus that browser’s eligible guest orders |
| Order details and guest tracking | `/bd/orders/:id`, `/bd/orders/recover/:id` | Original order, payment, shipment and signed single-order access |
| Saved Addresses | `/bd/account/addresses` | Shopper ID and market, one default per market |
| Help & Returns | `/bd/account/help`, `/bd/orders/:id/cases/:caseId` | Order, item, market, case events and confirmed refunds |
| Profile & Settings | `/bd/account/settings` | Market display name, language and marketing preference. Sign-in credentials and recovery remain in Better Auth |
| Staff packing and service | `/admin/orders/:id`, `/admin/cases/:id` | Existing packing queue, order, fulfillment audit and owner cases |

## Bangladesh My Orders staging

`/bd/orders` shows current storefront orders and earlier orders and pre-orders in one list. Link an earlier account using its verified legacy credentials. To save an unowned guest purchase, use its reference and checkout email from any signed-in device. The six-digit code expires after ten minutes and is single-use. For legacy purchases with a phone instead of an email, the hub can use a verified Bangladesh phone on the signed-in account and the exact reference.

The historical service reads a dedicated synthetic Mongo fixture over a private Docker network. Staging email is captured in the owner-only test inbox. The account mapping and recovery grants stay in the staging PostgreSQL database. Recent orders keep their existing private links, receipt details, tracking and service actions. Historical details show fulfillment and payment information with a support link.

The Android `ordersPreview` build opens this same URL. The earlier orders and recovery controls are available only with the isolated bridge and captured mail enabled. An approved historical export is required to exercise the hub with actual legacy records.

## Data and integrations

- Better Auth supplies the stable `Shopper.id` and shopper sessions. Bangladesh and US on the same dev origin share the shopper login. Seller Center already uses the shopper identity and existing seller-market approvals. Staff sessions use their own identity and permissions. Distinct production storefront hosts need a shared issuer or approved session exchange before cross-host sign-in can be validated.
- Market profiles, saved addresses and buyer-facing orders are scoped by shopper and market. Existing sign-in names are the fallback for a missing market profile. Dev carts are device-local and market-specific. The first market that opens a legacy browser cart keeps its contents. Syncing carts across devices remains pending.
- Order totals, currency and delivery snapshots are copied at checkout. Changing a saved address does not update the order. Bangladesh checkout normalizes recipient details and uses configured districts and the existing delivery eligibility checks. The dev order snapshot uses synthetic contact and address details.
- For Bangladesh COD, amount due comes from the existing payment amount while collection is outstanding. Owner-reviewed bKash, Nagad and Rocket proof keep their existing verification status. Dev previews never initiate a real payment. US checkout uses the configured test shipping quote and PayPal sandbox availability.
- Guest links are signed, expire after seven days and issue a single-order read cookie. The receipt-only view omits the delivery contact and address. A claim also requires the verified contact on the original order and original-browser or signed-link proof. Replays by the same owner are safe.
- Staff enter courier updates through the existing packing and fulfillment workflow. Use the dev shipment simulator for hosted tests. Carrier timestamps and estimates depend on available records. Staff process order-linked cases manually through the owner queue. Return receipt and confirmed refunds have separate records. Confirm a Bangladesh refund only once the real payout method and reference are known.
- Dev signup, verification, recovery and supported order notices use the owner-only test inbox. A real relay and approved SMS service are required for customer delivery. The language setting applies to Bangladesh account screens and supported account and order emails. Marketing preference stays separate from order and support updates. Account deletion requests use the existing owner inbox with manual ownership verification.
- Staff grants include permitted markets. Previous grants receive Bangladesh and US to preserve access. For a new Bangladesh-only employee use `STAFF_MARKETS=bd npm run staff:create -- packer <email> "<name>" < private-password-file`. Owners handle cases and approvals. Packing employees record shipment and fulfillment within their grants.

## Bangladesh migration and smoke sequence

1. Verify the intended dev revision, dedicated database, test-only order intake and mail preview. Back up its database and save the old image, Nginx config and app environment. Review a restore listing before activation.
2. Run `npm run db:generate` and `npm run db:migrate` through the intended release operator. Migrations add market address details and defaults, support records, profile preferences and staff grants. Legacy native saved addresses backfill to Bangladesh. Keep the shopper IDs and order foreign keys intact.
3. Existing signed-in native buyers retain their Bangladesh orders. An old guest order with an original verified contact can be claimed through the normal flow. Before importing legacy Mongo purchases, obtain an approved export of legacy IDs, verified contact evidence, payment and delivery snapshots and market provenance. Map Mongo `_id`, `phone_number` and `is_verified_number` to `legacyCustomerId`, `phoneNumber` and `phoneVerified`. Run `./node_modules/.bin/tsx scripts/plan-legacy-bd-accounts.ts <private-manifest.json> > <private-review.json>` against the intended environment. The read-only plan flags ambiguous and unverified records and proposes only unique, independently verified matches for operator review. Run it twice against the same snapshot and compare results before planning writeback. Leave ambiguous records available through support. Production Mongo data and identity keys are outside the dev migration.
4. Register a synthetic `@example.invalid` buyer, verify through the test inbox, sign in and select Bangla. Use a sample Bangladesh address with a landmark. Place a test COD order, check the BDT balance, advance it from the Bangladesh packing queue and read the new buyer status. Change the saved address and confirm the order’s snapshot. Test wrong-market and independent shopper access, private link scope and replayed claims.
5. Open an item case on a delivered test order. Use an owner to update it, and confirm a packer cannot read the case or download a photo. Confirm a refund only with a synthetic execution reference for a test order. Save or remove exact synthetic fixture records per the dev verification protocol and restore any reserved stock.

## US staging checklist

- Sign in once on dev, visit the US storefront with the same login and confirm the US cart, addresses and order history. Switch back to verify the Bangladesh history.
- Test accepted and rejected US shipping addresses against the configured checkout rule. Validate the original USD amount. Use mocked PayPal responses until the dev sandbox app credentials are configured.
- Verify historical US receipts, private links and staff market bounds. Validate a separate-origin session handshake only when the shared issuer is available.

## Rollback

Before rolling back to an image that predates market grants and verified claims, revoke sessions for narrowly scoped staff and suspend POST writes to the legacy marketplace command endpoint. Keep order reads, recovery and sign-in available. Repoint dev to the preceding runtime image with its prior environment and Nginx configuration, retaining those write restrictions. Keep additive migrations, identity IDs and signing secrets so order access survives. Confirm health and a known private receipt before clearing the rollout incident. Restore a database snapshot only for data recovery after review because later orders and account writes may be lost.

## Checks used for this release

- `npm run db:generate` and `npm run db:migrate` on the isolated PostgreSQL fixture, and the migration operator on dev.
- `npm run verify` passed lint, TypeScript, 38 unit tests and the production build.
- `npm run test:integration` passed 34 tests with one hybrid-only test skipped on the dedicated suite database. That test passed separately with `SHOPPER_MAIL_MODE=preview BD_MANUAL_TEST_MODE=1 ./node_modules/.bin/tsx --test tests/integration/order-notifications.test.ts` on the isolated hybrid fixture. The integration suite covers manual Bangladesh payment review and mocked PayPal destination checks, lost-capture reconciliation and refunds.
- `./node_modules/.bin/tsx scripts/plan-legacy-bd-accounts.ts <synthetic-manifest.json>` flagged duplicate, unverified and unmatched records. A synthetic verified-phone match produced identical results on two runs.
- `curl -fsS --max-time 12 https://dev.griipbuddy.com/api/health` confirmed the final revision `60afd6e1d118b6075a8d`, database health and test-only order intake. The activation verified the existing four additive account migrations and checked the Bangladesh and US account entry points.

### Hosted shopper and staff checks

The browser commands below were run on dev only. `$QA` refers to the private account QA directory, `$ADDRESS_QA` to the private address QA directory, and `$TEST_COD_ORDER` to the temporary COD fixture ID. The scripts use synthetic accounts and validate the target revision before making changes.

| Command | Result |
| --- | --- |
| `node "$QA/account-browser.cjs" 9e1a00f8eef57fa42cdf` | At 390 px, Bangladesh Bangla and US English account settings rendered without horizontal overflow. The same login opened separate profiles and carts. The Bangla password reset link opened from the test inbox in a fresh browser. Marketing opt-in and a repeat-safe deletion request were also checked through the signed-in account and owner inbox. |
| `node "$QA/order-claim-resume.cjs" 9e1a00f8eef57fa42cdf` | A synthetic Bangladesh COD receipt showed ৳1,130 due. A Bangladesh packer processed it through simulated delivery. An expiring guest link showed a private receipt with sensitive details redacted. Claim required a verified checkout contact and proof. Replays were safe, an unrelated shopper and wrong market were denied, and the old guest link lost access after claim. COD collection cleared the balance. Switching to the US hid the Bangladesh order and switching back restored access. |
| `node "$QA/case-smoke.cjs" 9e1a00f8eef57fa42cdf "$TEST_COD_ORDER"` | A mobile Bangla shopper opened an item case with a private photo and saw the owner’s reply. The packer and unrelated shopper could not read the case or photo. The English return flow recorded physical receipt before a simulated ৳1 bKash refund. The paid amount cap and refund replay checks passed. The customer saw the confirmed amount and method. |
| `GRIIP_ADDRESS_FULL_CRUD=1 node "$ADDRESS_QA/address-browser.cjs" "$ADDRESS_QA/hosted-address-credentials.json" 60afd6e1d118b6075a8d` | At 390 px, checked English and Bangla address validation, Bangla digit normalization, immediate updates after add, edit, default and delete, checkout reuse and save, and separation by shopper and market. Switching countries reset checkout contact. No order was created in this check. The address integration test separately covered existing delivery snapshots. |
| `node "$QA/account-keyboard.cjs" 60afd6e1d118b6075a8d` | Checked English and Bangla keyboard navigation at 390 px, including tab order, visible focus, Enter navigation, labelled profile fields and no horizontal overflow. |

The scoped fixture cleanup restored the reserved inventory unit, removed the test order, payment, shipment, cases, address records and captured inbox messages, and revoked the two test staff grants and sessions. A separate read-only check confirmed zero matching rows for the order workflow records, synthetic shoppers, captured messages, active staff grants and staff sessions.

## Pending

- Approved legacy identity and purchase export, ambiguity review and production migration.
- Shared identity across production hosts, verified sign-in contact changes and live transactional messaging. Dev support handles contact changes and deletion requests manually.
- Versioned preview terms are recorded on new Bangladesh and US orders in the global account release. Approved live policy and historical policy records remain pending.
- Self-service delivery corrections and redelivery need a carrier contract for eligibility and fee changes. Use the order-linked support path.
- Provider payment retry, saved payment methods and online refund settlement depend on configured provider capabilities and credentials.
- Multi-package estimates, multi-seller customer shipment grouping, seller escalation and provider-side partial refunds require validated fulfillment and settlement records.
- Buy again, variant alerts, exchanges, warranties, rewards and business billing require product and policy decisions. The MVP uses current native favorites and verified-purchase review paths.
