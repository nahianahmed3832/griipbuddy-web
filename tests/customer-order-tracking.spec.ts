import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type BrowserContext, type Page } from "@playwright/test";
import { storefrontCookiePath, storefrontPath } from "../src/config/storefront-path";
import { guestCookie, newGuestToken, readGuestKey } from "../src/lib/commerce/guest";
import { getDb } from "../src/lib/db/client";
import { requireLocalDatabase } from "../src/lib/db/local";

const confidential = /Private tracking fixture|01700001321|private-tracking@example\.test|Unpublished warehouse|Unpublished customs note|PRIVATE_CARRIER_EVENT/;
const unavailable = { error: { code: "tracking_unavailable", message: "Tracking is unavailable for this order." } };
const orderActions = { name: "Track order", exact: true };

test.use({ trace: "off" });

test.beforeEach(async ({ context, baseURL }) => {
  test.skip(process.env.GRIIPBUDDY_ENV_FILE !== ".env.test" || process.env.TEST_CUSTOMER_ORDER_TRACKING !== "1",
    "Requires the isolated tracking browser profile.");
  requireLocalDatabase("griipbuddy_test");
  if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1" || new URL(baseURL).origin !== process.env.BETTER_AUTH_URL) {
    throw new Error("Expected the configured isolated tracking browser origin.");
  }
  await allowLoopback(context, baseURL);
});

async function allowLoopback(context: BrowserContext, origin: string) {
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
}

async function shopper(page: Page, origin: string, email: string) {
  const credentials = { email, password: randomUUID() };
  const headers = { Origin: origin };
  const registered = await page.request.post(storefrontPath("/api/shopper-auth/sign-up/email"), { headers, data: { ...credentials, name: "Tracking fixture shopper" } });
  expect(registered.status()).toBe(200);
  const signedIn = await page.request.post(storefrontPath("/api/shopper-auth/sign-in/email"), { headers, data: credentials });
  expect(signedIn.status()).toBe(200);
  return getDb().shopper.findUniqueOrThrow({ where: { email } });
}

async function setGuestCookie(context: BrowserContext, origin: string, token: string) {
  await context.addCookies([{ name: guestCookie, value: token, domain: new URL(origin).hostname,
    path: storefrontCookiePath, httpOnly: true, sameSite: "Lax" }]);
}

async function seedOrder(token: string, shopperId?: string) {
  const guestKey = readGuestKey(token);
  if (!guestKey) throw new Error("Expected a fresh checkout fixture cookie.");
  return getDb().order.create({ data: {
    reference: `GB-${randomBytes(6).toString("hex").toUpperCase()}`, marketId: "bd", currency: "BDT",
    ...(shopperId && { shopper: { connect: { id: shopperId } } }),
    attempt: { create: { id: randomUUID(), guestKey, requestHash: randomBytes(32).toString("hex") } },
    customerName: "Private tracking fixture", phone: "01700001321", email: "private-tracking@example.test",
    address: "Private tracking fixture address", locality: "Test neighborhood", district: "dhaka", districtLabel: "Dhaka", postalCode: "1000",
    deliveryMethod: "standard", deliveryLabel: "Standard", taxLabel: "Tax", subtotalMinor: 150000, discountMinor: 0,
    deliveryMinor: 0, taxMinor: 0, totalMinor: 150000, measurementTest: true,
    items: { create: { variantId: "v-tote-oat", productName: "Tracking fixture tote", variantName: "Oat", sku: "TRK-OAT", quantity: 3,
      unitPriceMinor: 50000, unitDiscountMinor: 0, lineTotalMinor: 150000, currency: "BDT", personalization: "Unpublished customs note" } },
    payment: { create: { method: "COD", currency: "BDT", amountMinor: 150000 } },
  }, include: { items: true } });
}

type FixtureOrder = Awaited<ReturnType<typeof seedOrder>>;

async function splitPackages(order: FixtureOrder, locationId: string) {
  const db = getDb();
  const locationName = "Unpublished warehouse";
  await db.dispatchLocation.create({ data: { id: locationId, name: locationName, marketId: "bd" } });
  const deliveredAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const errorAt = new Date(Date.now() - 60 * 60 * 1000);
  const delayedReceipt = new Date(Date.now() - 15 * 60 * 1000);
  const estimate = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const delivered = await db.orderParcel.create({ data: {
    orderId: order.id, locationId, locationName, status: "DELIVERED", source: "MANUAL", statusUpdatedAt: deliveredAt,
    carrier: "Steadfast Courier", trackingReference: "SFT-TRACKING-123", estimatedDeliveryAt: estimate,
    items: { create: { orderItemId: order.items[0].id, quantity: 1 } },
    events: { create: [
      { status: "PLANNED", recordedAt: new Date(+deliveredAt - 60 * 60 * 1000) },
      { status: "DELIVERED", recordedAt: deliveredAt, reason: "Unpublished customs note" },
    ] },
  } });
  const exception = await db.orderParcel.create({ data: {
    orderId: order.id, locationId, locationName, status: "IN_TRANSIT", source: "MANUAL",
    trackingStatus: "DELIVERY_EXCEPTION", trackingOccurredAt: errorAt, trackingSyncedAt: delayedReceipt,
    estimatedDeliveryAt: estimate, carrier: "Fixture courier", trackingReference: "SAFE-CODE-2",
    items: { create: { orderItemId: order.items[0].id, quantity: 2 } },
    trackingObservations: { create: [
      { source: "CARRIER_WEBHOOK", status: "DELIVERY_EXCEPTION", occurredAt: errorAt, recordedAt: delayedReceipt,
        eventKey: "PRIVATE_CARRIER_EVENT", applied: true },
      { source: "CARRIER_WEBHOOK", status: "IN_TRANSIT", occurredAt: new Date(+errorAt - 5000), recordedAt: new Date(),
        eventKey: "PRIVATE_CARRIER_EVENT_LATE", applied: false },
    ] },
  } });
  return { delivered, exception, deliveredAt, errorAt, estimate };
}

async function cleanOrders(orders: FixtureOrder[], locationIds: string[], shopperEmails: string[] = []) {
  const db = getDb();
  const orderIds = orders.map(order => order.id);
  await db.$transaction([
    db.orderParcel.deleteMany({ where: { orderId: { in: orderIds } } }),
    db.payment.deleteMany({ where: { orderId: { in: orderIds } } }),
    db.orderItem.deleteMany({ where: { orderId: { in: orderIds } } }),
    db.order.deleteMany({ where: { id: { in: orderIds } } }),
    db.checkoutAttempt.deleteMany({ where: { id: { in: orders.map(order => order.attemptId) } } }),
    db.dispatchLocation.deleteMany({ where: { id: { in: locationIds } } }),
    db.shopper.deleteMany({ where: { email: { in: shopperEmails } } }),
  ]);
}

async function expectDenied(response: APIResponse) {
  expect(response.status()).toBe(404);
  expect(response.headers()["cache-control"]).toMatch(/private.*no-store/);
  expect(response.headers().vary).toMatch(/cookie/i);
  expect(response.headers()["referrer-policy"]).toBe("no-referrer");
  expect(response.headers()["x-robots-tag"]).toMatch(/noindex/);
  expect(await response.json()).toEqual(unavailable);
}

async function assertPrivatePage(page: Page, path: string) {
  const response = await page.goto(storefrontPath(path));
  expect(response?.headers()["cache-control"]).toMatch(/private.*no-store/);
  expect(response?.headers()["x-robots-tag"]).toMatch(/noindex/);
  expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
}

function trackingEndpoint(id: string, guest = false) {
  return storefrontPath(`/api/orders/${id}/tracking${guest ? "/guest" : ""}`);
}

async function expectSplit(page: Page, parcels: Awaited<ReturnType<typeof splitPackages>>, account: boolean) {
  const delivered = page.getByRole("article").filter({ hasText: "SFT-TRACKING-123" });
  const exception = page.getByRole("article").filter({ hasText: "SAFE-CODE-2" });
  await expect(delivered.getByText("Delivered", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("1 of 2 packages delivered", { exact: true })).toBeVisible();
  await expect(page.getByText("Partially delivered · delivery issue", { exact: true })).toBeVisible();
  if (account) await expect(delivered.getByRole("list", { name: "Items in this package" }).getByText("1 × Tracking fixture tote")).toBeVisible();
  await expect(delivered.locator(`time[datetime="${parcels.deliveredAt.toISOString()}"]`).first()).toBeVisible();
  await expect(delivered.getByText("Carrier delivery estimate", { exact: true })).toHaveCount(0);
  await expect(exception.getByText("Delivery exception", { exact: true }).first()).toBeVisible();
  await expect(exception.getByText(/A delivery issue was reported for this package/i)).toBeVisible();
  await expect(exception.getByText(/Carrier updates can take time to appear/i)).toBeVisible();
  if (account) await expect(exception.getByRole("list", { name: "Items in this package" }).getByText("2 × Tracking fixture tote")).toBeVisible();
  else await expect(page.getByRole("list", { name: "Items in this package" })).toHaveCount(0);
  await expect(exception.locator(`time[datetime="${parcels.errorAt.toISOString()}"]`).first()).toBeVisible();
  await expect(exception.locator(`time[datetime="${parcels.estimate.toISOString()}"]`)).toBeVisible();
  await expect(exception.getByRole("list", { name: "Tracking timeline" }).getByText("In transit", { exact: true })).toHaveCount(0);
  const lookup = delivered.getByRole("link", { name: /carrier tracking/i });
  await expect(lookup).toHaveAttribute("href", "https://www.steadfast.com.bd/tracking");
  await expect(lookup).toHaveAttribute("rel", /noreferrer/);
  await expect(exception.getByRole("link", { name: /carrier tracking/i })).toHaveCount(0);
}

test("account tracking keeps package states separate and denies another owner", async ({ page, browser, baseURL }) => {
  const origin = baseURL!;
  const locationId = `tracking-browser-${randomUUID()}`;
  const ownedEmail = `tracking-owner-${randomUUID()}@example.test`;
  const otherEmail = `tracking-other-${randomUUID()}@example.test`;
  const otherContext = await browser.newContext({ baseURL: origin });
  const orders: FixtureOrder[] = [];
  await allowLoopback(otherContext, origin);
  try {
    const owner = await shopper(page, origin, ownedEmail);
    const originalGuest = newGuestToken();
    const order = await seedOrder(originalGuest, owner.id);
    orders.push(order);
    const parcels = await splitPackages(order, locationId);
    await assertPrivatePage(page, "/orders");
    await expect(page.getByRole("heading", { name: "Purchases and reviews" })).toBeVisible();
    const orderEntry = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: order.reference, exact: true }) });
    const accountTracking = storefrontPath(`/orders/${order.id}/tracking`);
    await expect(orderEntry.getByRole("link", orderActions)).toHaveAttribute("href", accountTracking);
    await orderEntry.getByRole("link", { name: order.reference, exact: true }).click();
    const paymentStatus = page.getByRole("region", { name: "Payment and status" });
    await expect(paymentStatus.getByText("Payment status", { exact: true })).toBeVisible();
    await expect(paymentStatus.getByText("Delivered", { exact: true })).toHaveCount(0);
    const trackingLink = page.getByRole("link", orderActions);
    await trackingLink.focus();
    await expect(trackingLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(`${origin}${accountTracking}`);
    await expect(page.getByRole("heading", { name: "Track order", exact: true })).toBeVisible();
    await expect(page.getByText(order.reference, { exact: true }).first()).toBeVisible();
    await expectSplit(page, parcels, true);

    const authorized = await page.request.get(trackingEndpoint(order.id));
    expect(authorized.status()).toBe(200);
    expect(authorized.headers()["cache-control"]).toMatch(/private.*no-store/);
    expect(authorized.headers().vary).toMatch(/cookie/i);
    expect(authorized.headers()["referrer-policy"]).toBe("no-referrer");
    expect(await authorized.text()).not.toMatch(confidential);

    const other = await otherContext.newPage();
    await shopper(other, origin, otherEmail);
    await setGuestCookie(otherContext, origin, originalGuest);
    await expectDenied(await other.request.get(trackingEndpoint(order.id)));
    await expectDenied(await other.request.get(trackingEndpoint(order.id, true)));
    await assertPrivatePage(other, `/orders/${order.id}/tracking`);
    await expect(other.getByText(/Tracking unavailable|Page not found/i).first()).toBeVisible();
    expect(await other.content()).not.toMatch(confidential);
    expect(await other.content()).not.toContain(order.reference);
  } finally {
    await otherContext.close();
    await cleanOrders(orders, [locationId], [ownedEmail, otherEmail]);
  }
});

test("the guest browser can follow confirmation and footer links, without using a reference as proof", async ({ page, context, browser, baseURL }) => {
  const origin = baseURL!;
  const token = newGuestToken();
  const locationId = `tracking-browser-${randomUUID()}`;
  const thirdParty = await browser.newContext({ baseURL: origin });
  await allowLoopback(thirdParty, origin);
  const orders: FixtureOrder[] = [];
  try {
    const order = await seedOrder(token);
    orders.push(order);
    const preparingOrder = await seedOrder(token);
    orders.push(preparingOrder);
    const parcels = await splitPackages(order, locationId);
    await setGuestCookie(context, origin, token);
    await assertPrivatePage(page, `/orders/${order.id}`);
    await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
    await page.getByRole("link", orderActions).click();
    await expect(page).toHaveURL(`${origin}${storefrontPath(`/orders/track/${order.id}`)}`);
    await expect(page.getByRole("heading", { name: "Track your order", exact: true })).toBeVisible();
    await expectSplit(page, parcels, false);
    const activeMarkup = await page.content();
    expect(confidential.test(activeMarkup) || activeMarkup.includes(token)).toBe(false);
    const freshPage = await page.request.get(storefrontPath(`/orders/track/${order.id}`));
    const markup = await freshPage.text();
    expect(confidential.test(markup) || markup.includes(token)).toBe(false);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    await page.goto(storefrontPath(`/orders/${order.id}`));
    await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
    await page.getByRole("contentinfo").getByRole("link", { name: "Track your order" }).click();
    await expect(page).toHaveURL(`${origin}${storefrontPath("/orders/track")}`);
    expect(confidential.test(await page.content())).toBe(false);
    await page.getByRole("link", { name: new RegExp(`Track order ${preparingOrder.reference}`, "i") }).click();
    await expect(page.getByText("Preparing", { exact: true }).first()).toBeVisible();
    const visitor = await thirdParty.newPage();
    const actual = trackingEndpoint(order.id, true);
    await expectDenied(await visitor.request.get(actual));

    const invalid = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
    await setGuestCookie(thirdParty, origin, invalid);
    await expectDenied(await visitor.request.get(actual));
    await setGuestCookie(thirdParty, origin, newGuestToken());
    await expectDenied(await visitor.request.get(actual));

    const stale = `${token.split(".")[0]}.${Math.floor(Date.now() / 1000) - 1}`;
    const signature = createHmac("sha256", process.env.CHECKOUT_SECRET!).update("guest\0").update(stale).digest("hex");
    await setGuestCookie(thirdParty, origin, `${stale}.${signature}`);
    await expectDenied(await visitor.request.get(actual));
    await assertPrivatePage(visitor, "/orders/track");
    await expect(visitor.getByRole("heading", { name: "No orders verified in this browser" })).toBeVisible();
    await assertPrivatePage(visitor, `/orders/track/${order.id}`);
    await expect(visitor.getByText("Tracking unavailable", { exact: true })).toBeVisible();
    expect(await visitor.content()).not.toMatch(confidential);
    expect(await visitor.content()).not.toContain(order.reference);

    await setGuestCookie(thirdParty, origin, token);
    await expectDenied(await visitor.request.get(trackingEndpoint(order.reference, true)));
  } finally {
    await thirdParty.close();
    await cleanOrders(orders, [locationId]);
  }
});

test("refresh preserves accepted package data during an outage and clears it after access changes", async ({ page, context, browser, baseURL }) => {
  const origin = baseURL!;
  const locationId = `tracking-browser-${randomUUID()}`;
  const email = `tracking-claim-${randomUUID()}@example.test`;
  const token = newGuestToken();
  const claimantContext = await browser.newContext({ baseURL: origin });
  const orders: FixtureOrder[] = [];
  await allowLoopback(claimantContext, origin);
  try {
    const order = await seedOrder(token);
    orders.push(order);
    const parcels = await splitPackages(order, locationId);
    const claimant = await shopper(await claimantContext.newPage(), origin, email);
    await setGuestCookie(context, origin, token);
    const endpoint = `${origin}${trackingEndpoint(order.id, true)}`;
    const attempted: string[] = [];
    let failedStatus: 429 | 503 | undefined;
    await page.route(endpoint, async route => {
      attempted.push(route.request().method());
      if (!failedStatus) return route.continue();
      const status = failedStatus;
      failedStatus = undefined;
      await route.fulfill({ status, ...(status === 429 ? { headers: { "Retry-After": "60" } } : {}),
        json: { error: { code: status === 429 ? "rate_limited" : "tracking_temporarily_unavailable" } } });
    });

    await page.clock.install();
    await assertPrivatePage(page, `/orders/track/${order.id}`);
    await expectSplit(page, parcels, false);
    const refresh = page.getByRole("button", { name: "Refresh tracking", exact: true });
    await expect(refresh).toBeDisabled();
    await page.clock.fastForward(8000);
    await expect(refresh).toBeEnabled();
    const initialReads = attempted.length;
    const checkedAt = page.getByRole("region", { name: "Order tracking summary" }).locator("time");
    const lastSuccessfulRead = await checkedAt.getAttribute("datetime");

    failedStatus = 503;
    await refresh.click();
    await expect(page.getByRole("status").getByText(/Tracking could not be refreshed/i)).toBeVisible();
    await expect(checkedAt).toHaveAttribute("datetime", lastSuccessfulRead!);
    await expectSplit(page, parcels, false);
    await expect(refresh).toBeDisabled();
    expect(attempted).toHaveLength(initialReads + 1);

    const current = new Date();
    await getDb().orderParcel.update({ where: { id: parcels.exception.id }, data: {
      trackingStatus: "RETURNED", trackingOccurredAt: current, trackingSyncedAt: current, estimatedDeliveryAt: null,
      trackingObservations: { create: { source: "CARRIER_WEBHOOK", status: "RETURNED", occurredAt: current, eventKey: "PRIVATE_CARRIER_EVENT_RETURN", applied: true } },
    } });
    await page.clock.fastForward(16_000);
    await expect(refresh).toBeEnabled();
    await refresh.focus();
    await page.keyboard.press("Enter");
    const updated = page.getByRole("article").filter({ hasText: "SAFE-CODE-2" });
    await expect(updated.getByText("Returned", { exact: true }).first()).toBeVisible();
    await expect(updated.locator(`time[datetime="${parcels.estimate.toISOString()}"]`)).toHaveCount(0);
    expect(attempted).toHaveLength(initialReads + 2);

    await page.clock.fastForward(8000);
    await expect(refresh).toBeEnabled();
    failedStatus = 429;
    await refresh.click();
    await expect(page.getByRole("status").getByText(/Too many tracking checks/i)).toBeVisible();
    await expect(updated.getByText("Returned", { exact: true }).first()).toBeVisible();
    await page.clock.fastForward(30_000);
    await expect(refresh).toBeDisabled();
    expect(attempted).toHaveLength(initialReads + 3);

    await getDb().order.update({ where: { id: order.id }, data: { shopperId: claimant.id } });
    await page.clock.fastForward(32_000);
    await expect(refresh).toBeEnabled();
    await refresh.click();
    await expect(page.getByText("Tracking unavailable", { exact: true })).toBeVisible();
    await expect(page.getByText("SAFE-CODE-2", { exact: true })).toHaveCount(0);
    await expect(page.getByText(order.reference, { exact: true })).toHaveCount(0);
    expect(attempted).toHaveLength(initialReads + 4);
    expect(attempted.every(method => method === "GET")).toBe(true);
  } finally {
    await claimantContext.close();
    await cleanOrders(orders, [locationId], [email]);
  }
});
