import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { getDb } from "../src/lib/db/client";
import { requireLocalDatabase } from "../src/lib/db/local";
import { CART_STORAGE_KEY, decodeCart } from "../src/lib/cart/model";

const isolated = process.env.GRIIPBUDDY_ENV_FILE === ".env.test";
test.skip(!isolated, "Order browser tests require the isolated local test database.");
test.use({ trace: "off" });

async function capture(page: Page, name: string) {
  if (process.env.CAPTURE_STOREFRONT_SCREENSHOTS !== "1") return;
  await mkdir("docs/screenshots", { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `docs/screenshots/${name}.jpg`, fullPage: true, type: "jpeg", quality: 90 });
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

async function staffSignIn(page: Page, role: "PACKER" | "OWNER") {
  const email = process.env[`TEST_${role}_EMAIL`];
  const password = process.env[`TEST_${role}_PASSWORD`];
  if (!email || !password) throw new Error("Set the isolated test staff credentials.");
  await page.getByRole("textbox", { name: "Email address" }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in to staff dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Packing queue", exact: true })).toBeVisible();
}

test("Bangladesh guest COD checkout and protected packing from a real catalog variant", async ({ page, browser, baseURL }, info) => {
  requireLocalDatabase("griipbuddy_test");
  test.setTimeout(45_000);
  page.setDefaultTimeout(8_000);
  const db = getDb();
  const mobile = info.project.name === "narrow-mobile";
  const variantId = mobile ? "v-tote-plum" : "v-tote-oat";
  const option = mobile ? "Plum" : "Oat";
  const total = mobile ? "৳1,392.50" : "৳1,287.50";
  const before = await db.inventory.findUniqueOrThrow({ where: { variantId } });
  const staffContext = await browser.newContext({ baseURL });
  const stranger = await browser.newContext({ baseURL });
  staffContext.setDefaultTimeout(8_000);
  stranger.setDefaultTimeout(8_000);
  let createdOrderId: string | undefined;

  try {
    await page.goto("/products/canvas-carryall-tote");
    if (!mobile) await page.locator("label.variant-option").filter({ has: page.getByRole("radio", { name: option, exact: true }) }).click();
    await expect(page.getByRole("radio", { name: option, exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Add to cart" }).click();
    await page.getByRole("link", { name: "View cart", exact: true }).click();
    await page.getByRole("link", { name: "Guest checkout" }).click();

    await page.getByRole("textbox", { name: "Full name" }).fill("Preview Shopper");
    await page.getByRole("textbox", { name: "Phone number" }).fill("01700000000");
    await page.getByRole("textbox", { name: "Email (optional)" }).fill("shopper@example.test");
    await page.getByRole("combobox", { name: "District" }).selectOption("dhaka");
    await page.getByRole("textbox", { name: "Area or upazila", exact: true }).fill("Dhanmondi");
    await page.getByRole("textbox", { name: "Street address" }).fill("10 Preview Road");
    await page.getByRole("textbox", { name: "Postal code (optional)" }).fill("1209");
    await expect(page.getByRole("radio", { name: "Cash on delivery" })).toBeChecked();
    await noOverflow(page);
    if (!mobile) await capture(page, "checkout-desktop");
    await page.getByRole("button", { name: "Review order" }).click();
    await expect(page.getByRole("heading", { name: "Review your order" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Review your order" }).getByText(total, { exact: false })).toBeVisible();
    await noOverflow(page);
    await capture(page, mobile ? "checkout-review-mobile" : "checkout-review-desktop");

    if (mobile) {
      await page.route("**/api/checkout", async (route) => {
        if (route.request().postDataJSON().action !== "submit") { await route.continue(); return; }
        const response = await route.fetch();
        expect(response.ok()).toBeTruthy();
        const result = await response.json();
        createdOrderId = result.orderId;
        await route.abort("failed");
      });
    }
    await page.getByRole("button", { name: "Place COD order" }).click();
    if (mobile) {
      await expect(page.getByRole("alert").filter({ hasText: "couldn’t confirm" })).toBeVisible();
      const saved = await page.evaluate((key) => localStorage.getItem(key), CART_STORAGE_KEY);
      expect(decodeCart(saved)).toEqual([{ variantId, quantity: 1 }]);
      await page.reload();
      await expect(page.getByRole("heading", { name: "Check your last order" })).toBeVisible();
      await page.getByRole("button", { name: "Check for saved order" }).click();
    }
    await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
    const orderId = new URL(page.url()).pathname.split("/").pop()!;
    expect(orderId).toMatch(/^[0-9a-f-]{36}$/);
    createdOrderId = orderId;
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { items: true, payment: true } });
    expect(order.items).toHaveLength(1);
    expect(order.items[0].variantId).toBe(variantId);
    expect(order.payment?.status).toBe("AWAITING_COLLECTION");
    expect((await db.inventory.findUniqueOrThrow({ where: { variantId } })).available).toBe(before.available - 1);
    await expect(page.getByRole("link", { name: "Cart, 0 items" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Payment and status" }).getByText("Awaiting collection", { exact: true })).toBeVisible();
    await noOverflow(page);
    await capture(page, mobile ? "confirmation-mobile" : "confirmation-desktop");

    const privateResponse = await page.request.get(`/orders/${orderId}`);
    expect(privateResponse.headers()["cache-control"]).toContain("no-store");
    const unauthorized = await stranger.newPage();
    const denied = await unauthorized.goto(`/orders/${orderId}`);
    expect(denied?.headers()["cache-control"]).toContain("no-store");
    await expect(unauthorized.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();
    await expect(unauthorized.getByText("10 Preview Road")).toHaveCount(0);
    await expect(unauthorized.getByText("Preview Shopper")).toHaveCount(0);
    await unauthorized.goto(`/orders/${order.reference}`);
    await expect(unauthorized.getByRole("heading", { name: "Page not found", exact: true })).toBeVisible();

    const staffPage = await staffContext.newPage();
    await staffPage.goto(`/staff/orders/${orderId}`);
    await expect(staffPage.getByRole("heading", { name: "Staff sign-in" })).toBeVisible();
    await expect(staffPage.getByText("10 Preview Road")).toHaveCount(0);
    await staffSignIn(staffPage, "PACKER");
    await expect(staffPage.getByRole("link", { name: "Inventory and prices" })).toHaveCount(0);
    if (!mobile) await capture(staffPage, "packing-queue-desktop");
    await staffPage.getByRole("link", { name: order.reference, exact: true }).click();
    await expect(staffPage.getByRole("heading", { name: order.reference })).toBeVisible();
    await expect(staffPage.getByRole("button", { name: "Cancel order", exact: true })).toHaveCount(0);
    await expect(staffPage.getByText("shopper@example.test")).toHaveCount(0);
    await expect(staffPage.getByRole("button", { name: "Print packing slip" })).toBeVisible();
    await staffPage.emulateMedia({ media: "print" });
    await expect(staffPage.getByRole("heading", { name: "GriipBuddy packing slip" })).toBeVisible();
    await expect(staffPage.getByRole("heading", { name: order.reference })).toBeHidden();
    await staffPage.emulateMedia({ media: "screen" });

    const fulfillment = staffPage.waitForRequest((request) => request.method() === "POST" && Boolean(request.headers()["next-action"]));
    await staffPage.getByRole("button", { name: "Mark packing", exact: true }).click();
    const action = await fulfillment;
    await expect(staffPage.getByRole("button", { name: "Mark ready to ship" })).toBeVisible();
    const blocked = await stranger.request.post(action.url(), {
      headers: { "Next-Action": action.headers()["next-action"], "Content-Type": action.headers()["content-type"], Origin: baseURL! },
      data: action.postDataBuffer()!, timeout: 8000,
    });
    expect(await blocked.text()).toContain("Sign in as authorized staff");
    expect(await db.fulfillmentEvent.count({ where: { orderId, type: "STATUS_CHANGED" } })).toBe(1);

    await staffPage.getByRole("button", { name: "Mark ready to ship" }).click();
    await staffPage.getByRole("textbox", { name: "Carrier", exact: true }).fill("Demo carrier");
    await staffPage.getByRole("textbox", { name: "Tracking reference" }).fill("DEMO-TRACK-001");
    if (!mobile) await capture(staffPage, "packing-order-desktop");
    await staffPage.getByRole("button", { name: "Mark shipped" }).click();
    await staffPage.getByRole("button", { name: "Mark delivered" }).click();
    await expect(staffPage.getByText("Delivered", { exact: true }).first()).toBeVisible();
    await expect(staffPage.getByText("Awaiting collection", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByRole("region", { name: "Payment and status" }).getByText("Delivered", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Payment and status" }).getByText("Awaiting collection", { exact: true })).toBeVisible();
    const updated = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { payment: true } });
    expect(updated.fulfillmentStatus).toBe("DELIVERED");
    expect(updated.payment?.status).toBe("AWAITING_COLLECTION");

    await staffPage.goto("/staff/catalog");
    await expect(staffPage.getByRole("heading", { name: "Catalog access is unavailable", exact: true })).toBeVisible();
    await staffPage.goto("/staff");
    await expect(staffPage.getByRole("heading", { name: "Packing queue", exact: true })).toBeVisible();
    const signOutResponse = staffPage.waitForResponse("**/api/staff/sign-out");
    await staffPage.getByRole("button", { name: "Sign out", exact: true }).click();
    expect((await signOutResponse).status()).toBe(200);
    await expect(staffPage.getByRole("heading", { name: "Staff sign-in" })).toBeVisible();

    if (!mobile) {
      await staffSignIn(staffPage, "OWNER");
      await staffPage.getByRole("link", { name: "Inventory and prices" }).click();
      const beanie = staffPage.locator(".staff-catalog section").filter({ has: staffPage.getByRole("heading", { name: "Rib-Knit Beanie" }) });
      const originalStock = (await db.inventory.findUniqueOrThrow({ where: { variantId: "v-beanie-caramel" } })).available;
      await beanie.getByLabel(/^Stock adjustment/).fill("1");
      await beanie.getByLabel("Adjustment reason").fill("Browser test stock addition");
      await beanie.getByRole("button", { name: "Adjust stock" }).click();
      await expect(beanie.getByLabel(`Stock adjustment (${originalStock + 1} available)`)).toBeVisible();
      await beanie.getByLabel(/^Stock adjustment/).fill("-1");
      await beanie.getByLabel("Adjustment reason").fill("Restore browser test stock");
      await beanie.getByRole("button", { name: "Adjust stock" }).click();
      await expect(beanie.getByLabel(`Stock adjustment (${originalStock} available)`)).toBeVisible();
      await beanie.getByLabel("Bangladesh price (BDT)").fill("691");
      await beanie.getByRole("button", { name: "Save BDT price" }).click();
      await expect(beanie.getByLabel("Bangladesh price (BDT)")).toHaveValue("691.00");
      expect((await db.marketOffer.findUniqueOrThrow({ where: { variantId_marketId: { variantId: "v-beanie-caramel", marketId: "bd" } } })).amountMinor).toBe(69100);
      await beanie.getByLabel("Bangladesh price (BDT)").fill("690");
      await beanie.getByRole("button", { name: "Save BDT price" }).click();
      await expect(beanie.getByLabel("Bangladesh price (BDT)")).toHaveValue("690.00");

      await staffPage.goto(`/staff/orders/${orderId}`);
      await staffPage.getByRole("checkbox", { name: "I confirm the full amount was received." }).check();
      await staffPage.getByRole("button", { name: "Record collection" }).click();
      await expect(staffPage.getByText("Collected", { exact: true })).toBeVisible();
      expect((await db.payment.findUniqueOrThrow({ where: { orderId } })).status).toBe("COLLECTED");
    }
  } finally {
    if (createdOrderId) {
      const orderId = createdOrderId;
      await db.$transaction(async (tx) => {
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order) return;
        await tx.auditEvent.deleteMany({ where: { target: orderId } });
        await tx.fulfillmentEvent.deleteMany({ where: { orderId } });
        await tx.payment.delete({ where: { orderId } });
        await tx.orderItem.deleteMany({ where: { orderId } });
        await tx.order.delete({ where: { id: orderId } });
        await tx.checkoutAttempt.delete({ where: { id: order.attemptId } });
        await tx.inventory.update({ where: { variantId }, data: { available: { increment: 1 } } });
      });
    }
    await Promise.allSettled([staffContext.close(), stranger.close()]);
  }
});

test("United States browsing stays available while checkout is blocked on the server", async ({ page, baseURL }) => {
  await page.goto("/shop");
  await page.getByRole("contentinfo").getByRole("button", { name: /^Shopping preferences,/ }).click();
  await page.getByRole("combobox", { name: "Region" }).selectOption("us");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("contentinfo").getByRole("button", { name: "Shopping preferences, United States, USD" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("link", { name: /Canvas Carryall Tote/ })).toBeVisible();
  await page.goto("/checkout");
  await expect(page.getByText("Checkout is unavailable for this market.", { exact: true })).toBeVisible();
  const response = await page.request.post("/api/checkout", {
    headers: { Origin: baseURL! },
    data: { action: "review", checkout: { marketId: "bd" } },
  });
  expect(response.status()).toBe(422);
  expect(await response.json()).toMatchObject({ kind: "unavailable" });
});
