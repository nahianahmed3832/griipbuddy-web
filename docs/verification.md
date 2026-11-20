# Milestone 2 verification

Verified November 13, 2026, with Node.js 24.21.0, Next.js 16.4.3, Prisma 7.10.1, and PostgreSQL 17.11. The [local preview](http://127.0.0.1:3100/) uses `griipbuddy_dev`. Integration and browser tests use a separate `griipbuddy_test` database on the same local PostgreSQL instance; Playwright starts the production build at port 3101.

| Command | Result |
| --- | --- |
| `npm ci --offline` | Clean install from the lockfile using cached packages and Prisma engines. The postinstall generated the Prisma client without application credentials. |
| `npm run db:migrate` and `npm run db:seed` | Applied the migration and seeded 24 example products in both dedicated local databases. The test run used `GRIIPBUDDY_ENV_FILE=.env.test`. Reseeding the preview preserved the saved COD order and its inventory deduction. |
| `npm run typecheck` and `npm run lint` | Passed; no TypeScript or lint errors and no lint warnings. |
| `npm test` | 3 passed: market pricing and eligibility, cart behavior across markets, and quantity limits. |
| `npm run build` | Passed; compiled and type checked the production build. |
| `GRIIPBUDDY_ENV_FILE=.env.test npm run test:integration` | 10 passed against real PostgreSQL. |
| `CAPTURE_STOREFRONT_SCREENSHOTS=1 npm run test:e2e:database` | 16 passed on Chromium: eight each at desktop 1440 px and narrow mobile 320 px. |

Before the database changes, `npm run test:e2e` passed all 12 existing checks. The final browser run covers those storefront flows again: homepage, categories and collections, filters, search, variants, cart persistence and recovery, market switching, footer preferences, header demo sign-in, keyboard navigation, and the automated homepage accessibility scan.

The PostgreSQL checks exercised two concurrent buyers competing for the final unit, simultaneous duplicate submission and conflicting reuse, rollback after a stock decrement, and simultaneous owner cancellation restoring inventory once. They also checked server pricing and historical order snapshots, shared stock between markets, invalid quantities and destinations, review after pricing or delivery changes, abandonment, staff permissions, and separate delivery and cash collection.

The browser journey starts with a product variant and completes checkout, confirms the saved guest order and the stock change, denies access to the order in another browser, rejects unauthenticated access to staff pages and mutations, and follows the order through packing, shipping, and delivery. It verifies staff sign-out, owner stock and price editing, and that cash can only be recorded separately. The narrow mobile case also drops the first submit response and recovers the saved order. The US case checks browsing and server-side rejection of checkout.

Earlier browser runs exposed a staff sign-out issue and two incorrect assertions around streamed not-found responses and duplicate text. The sign-out flow and assertions were corrected and the full final run passed. The initial clean install hit a sandbox write restriction in the shared Prisma engine cache; the clean install passed with a writable cache. The PostgreSQL adapter emitted a pg deprecation warning, with no failed checks.

The preview contains synthetic order `GB-A1C427EFD54C` for one Canvas Carryall Tote, Oat. PostgreSQL recorded ৳1,150.00 in items, ৳80.00 for Dhaka delivery, and ৳57.50 in demo tax, for **৳1,287.50 due**. Stock moved from 7 to 6. The order remains unfulfilled and awaiting collection for the preview. The preview owner was able to sign in, see it in the queue, and sign out. The screenshots show orders from the separate automated test database.

- Checkout: [desktop form](screenshots/checkout-desktop.jpg), [desktop review](screenshots/checkout-review-desktop.jpg), [mobile review](screenshots/checkout-review-mobile.jpg)
- Confirmation: [desktop](screenshots/confirmation-desktop.jpg), [mobile](screenshots/confirmation-mobile.jpg)
- Staff: [packing queue](screenshots/packing-queue-desktop.jpg), [order details and packing controls](screenshots/packing-order-desktop.jpg)
- Storefront: [desktop homepage](screenshots/home-desktop.jpg), [mobile homepage](screenshots/home-mobile.jpg), [footer preferences](screenshots/shopping-preferences-desktop.jpg), [header sign-in](screenshots/sign-in-desktop.jpg)

See the [local setup and staff provisioning instructions](../README.md). The preview uses example products, delivery fees, and tax settings. Carrier and reference entry is manual. No production domain or payment provider was used.
