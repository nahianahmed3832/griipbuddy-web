# GriipBuddy Step 5 · Customer experience

The local branch `feature/storefront-customer` starts from Step 4 commit `3cee6c2`. The account area uses the existing GriipBuddy design, market paths, catalog and shopping bag. Google sign-in is a disabled design preview.

| Area | Local synthetic preview | Recovered API |
| --- | --- | --- |
| Customer login | Phone and verified email, with server-side sessions and logout | Existing verified customer phone login reuses the stored password and the recovered login contract. Email login is unavailable. |
| Registration and verification | New-only registration, purpose-bound phone OTP and separate email verification | Registration and numeric phone OTP were exercised directly on a disposable synthetic number using the isolated SMS stub. The storefront leaves those writes unavailable for recovered accounts because the legacy handler can replace an existing unverified or soft-deleted record. |
| Password recovery and security | Recovery OTP, reset and change password with expiry, attempt limits and session revocation | Self-service reset is unmounted. The change-password route uses the staff role guard. Existing customer credentials were kept as-is. |
| Dashboard, profile and addresses | Overview, profile editing, address add/edit/remove, and default address selection | Own profile and legacy addresses are read from the token-based endpoint. The self-update route is commented out, and the mounted staff updater is unsuitable for customer editing. |
| Order history, detail and tracking | Owner-scoped orders, line items, recorded status and tracking | Reads the recovered customer order list and additionally requires each order's explicit customer ID to match the authenticated user. The history scan checks up to 300 returned rows. Phone-only historical orders without an explicit owner are excluded. |
| Wishlist and cart | Account-scoped wishlist and shopping bag. A guest bag transfers on registration or login with an idempotency key and is cleared only after acknowledgement. | Recovered saved products are viewable. The guest bag stays on the same browser across login because the recovered API has no account cart contract. |
| Returns, refunds and notifications | Stores a request against a delivered owned order and saves notification preferences. | There is no verified customer return submission or notification-preference write route. The account offers a support link for returns. |
| Google sign-in | Design only | Design only |

## Recovery and safety

The recovered contract and route registry in the private recovery worktree show no mounted self-service recovery or refresh route. The recovered `customer-profile` module has unmounted staff-oriented sync and bulk-upload handlers. The storefront keeps those handlers and the public tracking endpoints out of the customer account flow.

The [account adapter](src/features/account/recovered.ts) accepts only the isolated IPv4 loopback API. It uses existing `POST /user/login`, `GET /user` and `GET /order/customer/my-order` reads. It requires a verified, active `USER` and normalizes the response to customer-facing fields. Requests for profiles, addresses and order details derive their owner from the server-side session. The browser never receives the recovered access or refresh token.

The storefront uses an opaque, expiring HttpOnly session cookie. Server logout invalidates the local handle. Recovered login expires at the earlier of 30 minutes and the upstream token expiry. The upstream API has no verified token revocation contract, and its profile read may be cached for up to three minutes. Account API responses are private and uncached, writes use the same-origin check, and synthetic OTPs are short-lived, purpose-bound and rate-limited.

Fixture accounts, passwords, addresses, notification preferences, return requests, sessions and account bags are held in the local preview process. They survive browser reloads and reset when that process restarts. Codes displayed by the fixture UI simulate delivery. The account preview does not send email or SMS, submit live return requests, or exchange OAuth credentials. Live recovery, persistent account writes and provider integration remain pending. All verification used isolated synthetic data.

## Reproducing verification

Start the fixture app on port 4315. The synthetic account for visual review accepts phone `01000000021` or email `maya@preview.invalid` with password `Preview-only-2026`.

```sh
npm ci
npm run lint
npm run build
npm test
npm run start -- --port 4315
```

For recovered API checks, start the isolated runner described in `LOCAL_DEVELOPMENT_GUIDE.md` in the private recovery worktree. Supply the private fixture password through `GRIIPBUDDY_TEST_FIXTURE_PASSWORD`, then run the guarded setup and tests from this storefront directory. The account API test guards its temporary MongoDB fixture using the expected loopback replica name, namespace and seed markers.

```sh
node tests/seed-catalog-api.mjs /path/to/local/recovered/backend
GRIIPBUDDY_TEST_SOURCE=api GRIIPBUDDY_TEST_BACKEND_DIR=/path/to/local/recovered/backend GRIIPBUDDY_CATALOG_MEDIA_ORIGINS=https://media.fixture.invalid npm test
```

Lint, the production build, 16 fixture tests and six recovered API tests passed. They cover phone and verified email login, Google design state, registration, wrong OTP and replay rejection, password reset and session revocation, profile, addresses and preferences, owned order tracking, wishlist, guest bag transfer and retry, and unauthorized access. The recovered suite rejects a synthetic order with the same phone and a different owner ID, staff credentials on the storefront, and writes to recovered customer credentials and profile.

[Desktop and mobile review screenshots](README.md#step-5-review-screenshots). Step 6 is pending review.
