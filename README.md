# GriipBuddy storefront

This Next.js app uses PostgreSQL for the catalog, uploaded product images, shared inventory, Bangladesh guest checkout, COD orders, and the packing dashboard. The United States market is open for browsing. Test checkout runs against a dedicated local or staging database.

The [measurement guide](docs/measurement.md) documents the event schema, commerce reconciliation, acquisition dashboard, and optional Clarity configuration.

The [homepage merchandising guide](docs/homepage-merchandising.md) covers market and language overrides, local schedules, staff permissions, and the evidence behind demand sections.

## Run locally

Use Node.js 24 LTS or Node.js 22.18+ and PostgreSQL 17. Create a local database and a password-protected database role that owns it. Use `griipbuddy_dev` for the preview and `griipbuddy_test` for verification. The example connects on port 55432. Use your PostgreSQL port if different.

```sh
npm ci
cp .env.example .env
# Set the local database URL and generate each secret separately with openssl rand -hex 32.
npm run db:migrate
npm run db:seed
npm run dev
```

Open [the storefront](http://127.0.0.1:3100/) or [staff sign-in](http://127.0.0.1:3100/staff/login). Use the configured origin in `BETTER_AUTH_URL` when signing in or placing an order. To run the production build locally, use `npm run build` and then `npm start`.

The Prisma migrations create and upgrade the commerce and Better Auth tables. The seed inserts the 24 example products, their offers, shared stock, and the Bangladesh delivery policy. Re-running it preserves existing prices, inventory, accounts, and orders. It requires a dedicated loopback database, or the private staging database with `ALLOW_DEMO_SEED=1`. `npm ci` generates the Prisma client. See [Prisma 7 PostgreSQL setup](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql).

### Create staff access

Use the database operator command with a unique password of at least 14 characters. In a POSIX shell, this prompts silently and pipes the password through stdin.

```sh
printf 'Staff password: '
stty -echo
IFS= read -r griipbuddy_staff_password
stty echo
printf '\n'
printf '%s\n' "$griipbuddy_staff_password" | npm run staff:create -- owner owner@example.test "Store Owner"
unset griipbuddy_staff_password
```

Use `npm run staff:create -- packer packer@example.test "Packing Staff" --markets=bd,us` with the same password prompt to assign a packer to the specified markets. Packing staff can view delivery details, print packing slips, and advance fulfillment within their assigned markets. Owners can also cancel before shipping, record cash received after delivery, manage products and market rules, and adjust stock. The database operator can run `npm run staff:revoke -- packer@example.test` to disable access and revoke sessions. See [Better Auth’s Prisma adapter](https://better-auth.com/docs/adapters/prisma).

### Try a COD order

1. Select Bangladesh in the footer. Open **Canvas Carryall Tote**, choose **Oat**, add one to the cart, and choose **Guest checkout**.
2. Enter synthetic contact and address details for Dhaka or Chattogram. Review items, delivery, tax, and the amount due. Place the COD order.
3. Open the confirmation or **Order status** in the same browser. The guest session lasts up to 30 days. The order reference alone cannot open the confirmation.
4. Sign in as staff at `/staff/login` and open the order in **Packing queue**. Mark it Packing, Ready to ship, Shipped, and Delivered. Enter a carrier and manual reference when shipping.
5. Refresh the customer’s order status to see the manual carrier, reference and fulfillment update. Payment stays **Awaiting collection** after delivery. An owner can separately record cash received or cancel an unshipped order and restore its stock.

The checkout fixtures charge ৳80 for Dhaka and ৳130 for Chattogram, with an explicit 5% demo tax on net merchandise. Owners can update shipping, COD and tax rules in **Market settings**. Orders require a supported market, tax configuration, and an eligible delivery option with a charge. Active offer discounts, if configured with valid dates, are applied before tax.

Checkout stores a unique attempt tied to the signed guest session and reviewed contents. Submit rechecks the quote against locked database rows, then writes the order, stock deduction, payment, and fulfillment event in one transaction. A retry returns the same persisted order. If the browser loses the response, use **Check for saved order** in that tab. Cancellation locks the order, restores stock once, and voids its unpaid COD record. Historical items retain their purchased names, SKUs, quantities, currency, and prices.

### Verify

Run the unit and build checks:

```sh
npm run verify
```

For the database suites, copy the example to `.env.test`. Use `griipbuddy_test`, independent secrets, and `BETTER_AUTH_URL=http://127.0.0.1:3101`. Migrate, seed, and create an owner and a packer using the same commands above with `GRIIPBUDDY_ENV_FILE=.env.test`. For Playwright, export `TEST_OWNER_EMAIL`, `TEST_OWNER_PASSWORD`, `TEST_PACKER_EMAIL`, and `TEST_PACKER_PASSWORD` from a local secret store or the ignored `.local/test-staff.env` file.

```sh
GRIIPBUDDY_ENV_FILE=.env.test npm run db:migrate
GRIIPBUDDY_ENV_FILE=.env.test npm run db:seed
GRIIPBUDDY_ENV_FILE=.env.test npm run test:integration
npx playwright install chromium
CAPTURE_STOREFRONT_SCREENSHOTS=1 npm run test:e2e:database
```

The database browser suite serves the standalone production build on port 3101. The launch journey creates identifiable synthetic catalog and order records. `npm run test:e2e` runs the storefront regressions on port 3100. For a private development environment set `GRIIPBUDDY_STAGE_URL`, `STAGING_USER`, `STAGING_PASSWORD` and the four test staff variables, then run `npm run test:e2e -- tests/launch.spec.ts`.

### Implementation and launch dependencies

| Area | Files |
| --- | --- |
| Database and local fixtures | `prisma/schema.prisma`, `prisma/migrations/`, `scripts/seed.ts` |
| Storefront catalog | `src/lib/catalog/repository.ts` |
| Quotes, guest session, and order creation | `src/lib/commerce/`, `src/app/api/checkout/` |
| Guest pages | `src/app/checkout/`, `src/app/orders/` |
| Staff authentication and operations | `src/lib/staff/`, `src/app/staff/`, `scripts/create-staff.ts` |

Use the [catalog import guide](docs/catalog-import.md) to prepare catalog data.
