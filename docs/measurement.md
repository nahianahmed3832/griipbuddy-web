# Storefront measurement

The Next.js storefront uses its PostgreSQL acquisition collector and market-scoped **Staff → Acquisition** dashboard. Owners can compare all markets. The recovered Express/MongoDB discovery and legacy checkout systems have separate data and authorities. The GA4 acquisition preview remains a preview payload for the existing reviewed campaign.

## Event contract

[Version 1 schema](../src/lib/measurement/schema.ts) defines accepted browser events and authoritative outcome names. The browser posts events asynchronously to the same-origin `/api/measurement` endpoint after consent. It sends a UUIDv4 nonce, version, UTC observation time, tab session UUID, selected market, and event-specific fields. A session rotates after 30 minutes of inactivity. The server verifies market from the request, bounds the observation timestamp, and stores a separate received time.

| Events | Recorded evidence |
| --- | --- |
| `HOMEPAGE_SECTION_IMPRESSION` | A section heading stays at least 50% intersecting for 750 ms in the foreground. Includes section placement, one-based order, and versioned homepage configuration. |
| `PRODUCT_IMPRESSION`, `PRODUCT_CLICK`, `PRODUCT_VIEW` | A card stays at least 50% intersecting for 750 ms in the foreground, a shopper activates a product link, or a product detail variant is viewed in the foreground. Includes catalog IDs, displayed minor-unit price and currency where available, and placement, position, and homepage configuration when provided. |
| `SEARCH`, `SEARCH_FILTER` | Completed search and applied or cleared filters with the result count before pagination. Zero results use `resultCount: 0`. Potential contact details and other sensitive-looking query text are omitted while retaining the count. |
| `WISHLIST_ADD`, `WISHLIST_REMOVE`, `CART_ADD`, `CART_UPDATE`, `CART_REMOVE` | Completed shopping actions with the available product and variant IDs, quantity, and displayed offer context. |
| `CHECKOUT_START`, `CHECKOUT_STEP`, `CHECKOUT_FAILURE` | Entry to checkout and applicable address, delivery/payment, review, submit, provider redirect, recovery, and external handoff steps. Failures use bounded codes for validation, network, unavailable, rejected, or cancelled. |
| `ACCOUNT_ASSOCIATED` | The server confirms a signed-in shopper in an opted-in session, then derives an account pseudonym. Earlier events can be joined by consented journey and session. Those events retain their original anonymous identity. |
| `EXPERIMENT_EXPOSURE` | The first qualifying visible recommendation slot for an enrolled journey and placement. Uses the common foreground card visibility threshold and stores the recommendation version. |
| `ORDER_ACCEPTED`, `ORDER_CANCELLED` | Saved order and committed cancellation. Order acceptance covers COD booking. |
| `PAYMENT_PAID`, `PAYMENT_FAILED`, `ORDER_REFUNDED` | Committed capture or verified provider failure evidence. PayPal refunds require a saved provider refund reference. Abandonment and client checkout errors are measured separately. |
| `ORDER_DELIVERED`, `ORDER_REFUSED`, `RETURN_REQUESTED`, `RETURN_RECEIVED` | Committed fulfillment, parcel, and return records. More than one parcel or return may contribute evidence to an order. |
| `COD_COLLECTED`, `COD_REMITTED` | Confirmed cash collection and matched carrier remittance. The latter includes recorded gross, deductions, and net amount. |

Browser rows use a server-derived event ID keyed by the signed anonymous journey, kind, and nonce. Reusing the same nonce for the same event type is idempotent. Reports project versioned commerce outcomes from committed orders, checkout attempts, payments, fulfillment, returns and remittances with stable IDs. Commerce events use the saved order market, currency, amount and transaction pseudonym. Checkout linkage also checks the guest session, active consent and test classification. Attribution is best effort and asynchronous while the saved commerce records remain authoritative.

The browser supplies a finite campaign source label. The existing reviewed campaign also requires an exact UTM match and matching product and market. No raw referrer URLs, tracking IDs, account IDs, checkout form fields, payment details, or error messages belong in the event payload. `experimentAssignment` joins a placement event to the server-verified experiment and variant for the same market and consented journey. `recommendationVersion` records the delivered ranking or baseline version. Homepage configurations use versioned layout labels.

The signed first-party choice permits collection for up to seven days. Measurement journeys and joins are pruned after 30 days. Withdrawing deletes the journey, events and measurement links while preserving the commerce records. Global Privacy Control and storefront staff sign-in suppress new behavior collection. Native test orders, known demo items, and same-origin staff checkout are excluded from production reporting. Use an isolated environment for anonymous staff tests.

## Reading the dashboard

- Choose an authorized market and a date window. Each report uses its market calendar, timezone, and transaction currency. Compare multiple markets when assigned reporting permissions for each.
- A qualified session has a product interaction, search or filter, wishlist add, cart add, or checkout entry. A visible impression alone does not qualify it.
- Product-to-cart counts sessions that add the same product after viewing it. Checkout conversion counts started sessions linked to a saved order. Commerce counts also cover eligible native orders without a measurement link.
- Search demand includes searches and zero-result counts. The query table requires repeated observations from separate sessions.
- Booked merchandise net of discounts, delivery charged, captured amounts, cash collected, and matched remittance amounts are shown separately. Contribution profit requires complete, current, order-level financial evidence.
- Native PayPal and SSLCOMMERZ are sandbox integrations. Where Bangladesh checkout redirects to the legacy origin, this storefront can observe the handoff. The legacy order and courier lifecycle needs its own verified server-side bridge to appear here.

## Configuration and replay verification

1. Apply the storefront Prisma migrations with the deploy database role, then grant the runtime role access to the new tables using the existing deployment procedure. Enable `ACQUISITION_MEASUREMENT=1` in the storefront runtime. Keep the existing `CHECKOUT_SECRET` in the runtime secret configuration.
2. For optional replay, set the public market project IDs `CLARITY_PROJECT_ID_BD` and `CLARITY_PROJECT_ID_US` or the shared `CLARITY_PROJECT_ID`. Use dedicated QA projects for verification. Enable Consent Mode and Strict masking in project settings. Check the tag manager and hosting template for another Clarity tag before enabling this one. [Microsoft consent API](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-consent-api-v2) · [Clarity masking settings](https://learn.microsoft.com/en-us/clarity/setup-and-installation/clarity-masking).
3. With both choices off, browse a clean public catalog URL and verify that the Clarity tag and collector remain idle. Use **Privacy choices** to enable shopping measurement and then separately enable session replay. Verify the SDK passes analytics consent and denies ad storage. In Clarity, confirm a tagged recording includes the expected `market` and `page_type` and that content is masked.
4. Navigate to search, cart, checkout, orders, account and staff. These routes have a separate document without the replay tag. Withdraw replay and verify the browser unloads the tag and stops collecting. Withdraw shopping measurement and confirm the test journey disappears while the saved order remains.
5. Compare replay off and on with a representative mobile profile on QA. Observe network transfer, LCP, interaction responsiveness, and fresh recordings. Local browser tests run at desktop and narrow-mobile widths with an intercepted tag. They check deferred loading, consent, tagging, private route exclusion, withdrawal, and browsing while the tag response stalls.

Replay covers eligible anonymous public home, catalog, and product pages. Search URLs and unapproved query parameters are excluded. Public and private pages use separate Next.js documents so the replay runtime cannot carry across that boundary. The provider's project controls govern retention and deletion of recordings already sent to Clarity.
