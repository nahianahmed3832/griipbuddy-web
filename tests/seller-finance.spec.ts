import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { getDb } from "../src/lib/db/client.ts";
import { requireLocalDatabase } from "../src/lib/db/local.ts";
import { recordCodRemittance } from "../src/lib/staff/cod-remittance.ts";

test.skip(process.env.GRIIP_SELLER_FINANCE_TEST !== "1", "Seller finance acceptance requires explicitly enabled test finance.");
test.use({ trace: "off", screenshot: "off" });

const db = () => getDb();
test.afterAll(async () => { await db().$disconnect(); });

async function loopback(context: BrowserContext, origin: string) {
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
}

async function shopper(context: BrowserContext, origin: string) {
  const email = `seller-finance-${randomUUID()}@example.test`;
  const password = randomUUID();
  const headers = { Origin: origin };
  const signup = await context.request.post("/api/shopper-auth/sign-up/email", { headers, data: { email, password, name: "Synthetic finance seller" } });
  expect(signup.status()).toBe(200);
  const signin = await context.request.post("/api/shopper-auth/sign-in/email", { headers, data: { email, password } });
  expect(signin.status()).toBe(200);
  return db().shopper.findUniqueOrThrow({ where: { email } });
}

async function signInStaff(context: BrowserContext, origin: string, role: "OWNER" | "PACKER") {
  const email = process.env[`TEST_${role}_EMAIL`];
  const password = process.env[`TEST_${role}_PASSWORD`];
  assert(email && password, "Set isolated finance browser staff credentials.");
  const response = await context.request.post("/api/staff/sign-in", { headers: { Origin: origin }, data: { email, password } });
  expect(response.status()).toBe(200);
  return db().user.findUniqueOrThrow({ where: { email }, select: { id: true } });
}

async function bdOrder(shopId: string, reference: string) {
  return db().order.create({ data: {
    attempt: { create: { id: randomUUID(), guestKey: randomBytes(32).toString("hex"), requestHash: randomBytes(32).toString("hex") } },
    reference, marketId: "bd", currency: "BDT", fulfillmentStatus: "DELIVERED", measurementTest: true, commerceEvidence: "fixture",
    customerName: "Synthetic finance buyer", phone: "01700000099", address: "Synthetic address", locality: "Dhaka",
    district: "dhaka", districtLabel: "Dhaka", deliveryLabel: "Standard", deliveryMethod: "standard", taxLabel: "Tax",
    subtotalMinor: 100_000, discountMinor: 10_000, taxMinor: 6_000, deliveryMinor: 12_000, totalMinor: 108_000,
    items: { create: { variantId: "v-tote-oat", marketplaceShopId: shopId, productName: "Synthetic seller allocation", sku: "TEST-SELLER-FINANCE",
      variantName: "Oat", quantity: 1, unitPriceMinor: 100_000, unitDiscountMinor: 10_000,
      lineTotalMinor: 90_000, taxAllocatedMinor: 6_000, deliveryAllocatedMinor: 12_000, currency: "BDT" } },
    payment: { create: { method: "COD", status: "COLLECTED", amountMinor: 108_000, currency: "BDT", collectedAt: new Date() } },
  } });
}

async function capture(page: Page, name: string) {
  const target = process.env.M08_FINANCE_SCREENSHOTS;
  if (!target) return;
  await mkdir(target, { recursive: true });
  const viewport = page.viewportSize();
  const size = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.width + 2);
  expect(viewport?.width).toBeGreaterThanOrEqual(320);
  await page.screenshot({ path: `${target}/m08-${name}.png`, animations: "disabled" });
}

test("owner and seller exercise synthetic policy, COD statement, destination, payout timeout and reconciliation", async ({ page, context, browser, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  requireLocalDatabase("griipbuddy_test");
  assert(baseURL && new URL(baseURL).hostname === "127.0.0.1" && baseURL === process.env.BETTER_AUTH_URL);
  await loopback(context, baseURL);
  const options = { baseURL, viewport: page.viewportSize() ?? undefined, isMobile: testInfo.project.name === "narrow-mobile" };
  const staffContext = await browser.newContext(options);
  const packerContext = await browser.newContext(options);
  const sellerDenied = await browser.newContext(options);
  try {
    for (const viewer of [staffContext, packerContext, sellerDenied]) await loopback(viewer, baseURL);
    const seller = await shopper(context, baseURL);
    const unrelated = await shopper(sellerDenied, baseURL);
    expect(seller.id).not.toBe(unrelated.id);
    const suffix = randomUUID().slice(0, 8);
    const shop = await db().marketplaceShop.create({ data: {
      ownerId: seller.id, published: true, name: "Synthetic Finance Studio", slug: `finance-${suffix}`, about: "", announcement: "",
      marketGrants: { create: [{ marketId: "bd", status: "APPROVED" }, { marketId: "us", status: "APPROVED" }] },
    } });

    const staff = await staffContext.newPage();
    const actor = await signInStaff(staffContext, baseURL, "OWNER");
    const staffRoute = `/staff/seller-finance?market=bd&shop=${shop.id}`;
    const sellerRoute = `/seller/finance?market=bd&shop=${shop.id}`;
    const staffResponse = await staff.goto(staffRoute, { waitUntil: "domcontentloaded" });
    expect(staffResponse?.headers()["referrer-policy"]).toBe("same-origin");
    await expect(staff.getByRole("heading", { name: "Seller finance administration" })).toBeVisible();
    await staff.getByLabel("Commission (basis points)").fill("750");
    await staff.getByLabel("Processing fee (basis points)").fill("50");
    await staff.getByLabel("Hold days").fill("0");
    await staff.getByRole("button", { name: "Publish test policy" }).click();
    await expect(staff.getByRole("region", { name: "Effective test policy" })).toContainText("7.5%");

    const reference = `GB-TEST-${suffix}`;
    const order = await bdOrder(shop.id, reference);
    const reconcileOrder = async () => {
      const region = staff.getByRole("region", { name: "Reconcile source records" });
      await region.getByLabel("Order ID").first().fill(order.id);
      await region.getByRole("button", { name: "Reconcile order" }).click();
    };
    await reconcileOrder();
    await expect(staff.getByRole("region", { name: "Statement entries" })).toContainText(reference);
    const sellerResponse = await page.goto(sellerRoute, { waitUntil: "domcontentloaded" });
    expect(sellerResponse?.headers()["referrer-policy"]).toBe("same-origin");
    await expect(page.getByText("No test destinations saved.")).toBeVisible();
    await expect(page.getByText("Use a verified test destination to continue.")).toBeVisible();

    expect(await recordCodRemittance(actor.id, order.id, { reference: `TEST-REM-${suffix}`, grossMinor: 108_000,
      deductionsMinor: 2_000, netMinor: 106_000 })).toBe("MATCHED");
    await staff.reload({ waitUntil: "domcontentloaded" });
    await reconcileOrder();
    await expect(staff.getByRole("region", { name: "Statement entries" })).toContainText("Released to available");

    const destination = `TEST-DEST-${suffix}`;
    await page.getByText("Add a test destination", { exact: true }).click();
    await page.getByLabel("Destination label").fill("Synthetic payout destination");
    await page.getByLabel("Synthetic reference").fill(destination);
    await page.getByRole("button", { name: "Submit for verification" }).click();
    await expect(page.getByText("Awaiting review", { exact: true })).toBeVisible();
    expect(await page.locator("main").innerText()).not.toContain(destination);

    await staff.reload({ waitUntil: "domcontentloaded" });
    await staff.getByText("Review destination", { exact: true }).click();
    await staff.getByRole("region", { name: "Destination review" }).locator("details[open]").getByLabel("Reason").fill("Synthetic destination reviewed");
    await staff.getByRole("button", { name: "Record destination decision" }).click();
    await expect(staff.getByText("Verified", { exact: true })).toBeVisible();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.getByLabel("Amount (BDT)", { exact: true }).fill("100.05");
    await page.getByRole("button", { name: "Submit test payout" }).click();
    await expect(page.getByRole("region", { name: "Test payout history" })).toContainText("Requested");
    await staff.reload({ waitUntil: "domcontentloaded" });
    await staff.getByText("Review test payout", { exact: true }).click();
    await staff.getByRole("region", { name: "Test payout queue" }).locator("details[open]").getByLabel("Reason").fill("Fixture approval");
    await staff.getByRole("button", { name: "Save payout review" }).click();
    await expect(staff.getByRole("region", { name: "Test payout queue" })).toContainText("Approved");

    await staff.getByText("Process test payout", { exact: true }).click();
    await staff.getByLabel("Simulated outcome").selectOption("TIMEOUT");
    await staff.getByRole("region", { name: "Test payout queue" }).locator("details[open]").getByLabel("Reason").fill("Synthetic response timeout");
    await staff.getByRole("button", { name: "Record simulated attempt" }).click();
    const queue = staff.getByRole("region", { name: "Test payout queue" });
    await expect(queue).toContainText("Reconciliation needed");
    await queue.scrollIntoViewIfNeeded();
    await capture(staff, `staff-finance-${testInfo.project.name}`);

    await staff.getByText("Reconcile test payout", { exact: true }).click();
    await staff.getByRole("region", { name: "Test payout queue" }).locator("details[open]").getByLabel("Reason").fill("Synthetic completion evidence");
    await staff.getByRole("button", { name: "Save reconciliation" }).click();
    await expect(queue).toContainText("Completed");

    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(page.getByRole("region", { name: "Test payout history" })).toContainText("Completed");
    const balances = page.getByRole("region", { name: "Current balances" });
    await expect(balances).toContainText("৳100.05");
    await balances.scrollIntoViewIfNeeded();
    await capture(page, `seller-finance-${testInfo.project.name}`);
    const exports = `/api/marketplace/seller/finance.csv?market=bd&shop=${shop.id}`;
    const related = await context.request.get(exports);
    expect(related.status()).toBe(200);
    expect(related.headers()["cache-control"]).toContain("private, no-store");
    const csv = await related.text();
    expect(csv).toContain(reference);
    expect(csv).toContain('"bd","BDT"');
    expect(csv).not.toContain(destination);
    expect((await sellerDenied.request.get(exports)).status()).toBe(404);
    const us = await context.request.get(exports.replace("market=bd", "market=us"));
    expect(us.status()).toBe(200);
    expect(await us.text()).not.toContain(reference);

    await signInStaff(packerContext, baseURL, "PACKER");
    expect((await packerContext.request.get(`/api/staff/seller-finance.csv?market=bd&shop=${shop.id}`)).status()).toBe(404);
  } finally {
    await Promise.all([staffContext.close(), packerContext.close(), sellerDenied.close()]);
  }
});
