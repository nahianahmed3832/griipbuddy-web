import { expect, test, type Browser, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const local = !process.env.GRIIPBUDDY_STAGE_URL && process.env.GRIIPBUDDY_ENV_FILE === ".env.test";
test.skip(!local, "Requires an isolated local test database.");
test.use({ trace: "off" });

function contextOptions(baseURL: string) {
  if (new URL(baseURL).origin !== "http://127.0.0.1:3101") throw new Error("Expected the isolated local origin.");
  return { baseURL };
}

async function signIn(browser: Browser, baseURL: string, role: "OWNER" | "PACKER") {
  const context = await browser.newContext(contextOptions(baseURL));
  const page = await context.newPage();
  await page.goto("/staff/login");
  await page.getByRole("textbox", { name: "Email address" }).fill(process.env[`TEST_${role}_EMAIL`]!);
  await page.getByLabel("Password", { exact: true }).fill(process.env[`TEST_${role}_PASSWORD`]!);
  await page.getByRole("button", { name: "Sign in to staff dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Packing queue", exact: true })).toBeVisible();
  return { context, page };
}

async function fillCheckout(page: Page) {
  await page.getByRole("textbox", { name: "Full name" }).fill("Acquisition Fixture");
  await page.getByRole("textbox", { name: "Phone number" }).fill("01700000000");
  await page.getByRole("textbox", { name: "Email (optional)" }).fill("acq-fixture@example.test");
  await page.getByRole("combobox", { name: "District" }).selectOption("dhaka");
  await page.getByRole("textbox", { name: /Area (?:\/|or) upazila/i }).fill("Dhanmondi");
  await page.getByRole("textbox", { name: "Street address" }).fill("Fixture street address");
}

const shop = "/products/canvas-carryall-tote?variant=v-tote-oat";
const report = "/staff/acquisition?scope=test";
const events = report + "&view=events";
const orderRows = (page: Page) => page.getByRole("row").filter({ hasText: "Order accepted" });

async function dashboard(page: Page) {
  const metric = async (region: string, label: string, index = 0) => {
    const value = await page.getByRole("region", { name: region, exact: true }).getByText(label, { exact: true })
      .locator("..").locator("dd").nth(index).innerText();
    return Number.parseInt(value.replaceAll(",", ""), 10);
  };
  return {
    qualified: await metric("Shopping funnel", "Qualified sessions"),
    productToCart: await metric("Shopping funnel", "Product to cart", 1),
    checkoutToOrder: await metric("Shopping funnel", "Checkout to order", 1),
    codOrders: await metric("Order, payment and delivery outcomes", "COD orders placed"),
    codAwaiting: await metric("Order, payment and delivery outcomes", "COD awaiting collection"),
    codCollected: await metric("Order, payment and delivery outcomes", "COD collected"),
    delivered: await metric("Order, payment and delivery outcomes", "Delivered orders"),
  };
}

async function screenshot(page: Page, name: string) {
  const out = process.env.ACQUISITION_SCREENSHOTS;
  if (!out) return;
  await mkdir(out, { recursive: true });
  await page.screenshot({ path: out + "/" + name + ".png", fullPage: true });
}

test("consented checkout records one committed order, evidenced collection, privacy and cohort separation", async ({ browser, baseURL }, info) => {
  test.skip(info.project.name !== "desktop", "Single journey; mobile commerce has its own regression.");
  test.setTimeout(80_000);
  const shopper = await browser.newContext(contextOptions(baseURL!));
  const page = await shopper.newPage();
  page.setDefaultTimeout(10_000);
  const blocked = await browser.newContext({ ...contextOptions(baseURL!), extraHTTPHeaders: { "Sec-GPC": "1" } });
  const owner = await signIn(browser, baseURL!, "OWNER");
  const packer = await signIn(browser, baseURL!, "PACKER");
  const query = { Origin: baseURL! };
  let checkoutSubmit: object | undefined;
  let createdId: string | undefined;
  const bodies: { payload: Record<string, unknown>; referer?: string }[] = [];
  const externalRequests = new Set<string>();
  page.on("request", request => {
    const url = new URL(request.url());
    if (/google-analytics|googletagmanager|facebook|fbevents/.test(url.hostname)) externalRequests.add(url.hostname);
    if (url.pathname === "/api/measurement" && request.method() === "POST") {
      bodies.push({ payload: request.postDataJSON(), referer: request.headers().referer });
    }
    if (url.pathname === "/api/checkout" && request.method() === "POST" && request.postDataJSON().action === "submit") {
      checkoutSubmit = request.postDataJSON();
    }
  });
  try {
    await owner.page.goto(report + "&market=us");
    const otherMarket = await dashboard(owner.page);
    await owner.page.goto(report);
    const baseline = await dashboard(owner.page);
    await expect(owner.page.getByRole("region", { name: "Contribution profit" }).getByText("Unavailable.", { exact: true })).toBeVisible();
    await owner.page.goto(events);
    const before = await orderRows(owner.page).count();
    const beforeRefs = new Set(await orderRows(owner.page).locator("code").allTextContents());
    await page.goto(shop + "&token=never-collect-this&email=pii-fixture%40example.test");
    await page.getByText("Privacy choices", { exact: true }).click();
    await page.getByRole("button", { name: "Keep measurement off" }).click();
    await expect(page.getByText("Shopping measurement is off.", { exact: true })).toBeVisible();
    expect(bodies.filter(row => row.payload.action !== "withdraw")).toHaveLength(0);
    expect((await shopper.cookies()).some(cookie => cookie.name === "griipbuddy-measurement")).toBe(false);

    const gpc = await blocked.request.post("/api/measurement", { headers: query, data: { action: "allow" } });
    expect(await gpc.json()).toMatchObject({ choice: "blocked" });
    expect((await blocked.cookies()).some(cookie => cookie.name === "griipbuddy-measurement")).toBe(false);

    const viewed = page.waitForResponse(response => response.url().endsWith("/api/measurement") &&
      response.request().method() === "POST" && response.request().postDataJSON().action === "PRODUCT_VIEW");
    await page.getByRole("button", { name: "Allow shopping measurement" }).click();
    expect((await viewed).ok()).toBeTruthy();

    const forged = await shopper.request.post("/api/measurement", { headers: query,
      data: { action: "ORDER_ACCEPTED", orderId: "fake", totalMinor: 1, paid: true } });
    expect(forged.status()).toBe(400);
    const extra = await shopper.request.post("/api/measurement", { headers: query,
      data: { action: "CHECKOUT_START", nonce: "efd9ea22-24cd-43dd-935e-04f4410181a1", email: "pii-fixture@example.test" } });
    expect(extra.status()).toBe(400);

    const added = page.waitForResponse(response => response.url().endsWith("/api/measurement") &&
      response.request().method() === "POST" && response.request().postDataJSON().action === "CART_ADD");
    await page.getByRole("button", { name: "Add to cart" }).click();
    const addResponse = await added;
    expect(addResponse.ok()).toBeTruthy();
    const repeated = await shopper.request.post("/api/measurement", { headers: query, data: addResponse.request().postDataJSON() });
    expect(repeated.ok()).toBeTruthy();
    await page.getByRole("link", { name: "View cart", exact: true }).click();

    const entered = page.waitForResponse(response => response.url().endsWith("/api/measurement") &&
      response.request().method() === "POST" && response.request().postDataJSON().action === "CHECKOUT_START");
    await page.getByRole("link", { name: "Guest checkout" }).click();
    await fillCheckout(page);
    expect((await entered).ok()).toBeTruthy();

    const failed = await shopper.request.post("/api/checkout", { headers: query, data: { action: "submit", checkout: {} } });
    expect(failed.status()).toBe(409);
    await owner.page.reload();
    expect(await orderRows(owner.page).count()).toBe(before);
    await page.getByRole("button", { name: "Review order" }).click();
    await expect(page.getByRole("heading", { name: "Review your order" })).toBeVisible();
    await page.getByRole("button", { name: "Place COD order" }).click();
    await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Payment and status" }).getByText("Awaiting collection", { exact: true })).toBeVisible();
    const id = new URL(page.url()).pathname.split("/").at(-1)!;
    createdId = id;
    expect(checkoutSubmit).toBeTruthy();
    const retry = await shopper.request.post("/api/checkout", { headers: query, data: checkoutSubmit });
    expect(await retry.json()).toMatchObject({ kind: "placed", orderId: id });

    await page.reload();
    await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
    expect((await page.request.get("/orders/" + id)).headers()["referrer-policy"]).toBe("no-referrer");
    await expect.poll(async () => { await owner.page.reload(); return orderRows(owner.page).count(); }).toBe(before + 1);
    const snapshot = owner.page.getByRole("heading", { name: "GA4 payload preview" });
    await expect(snapshot).toBeVisible();
    const newRef = (await orderRows(owner.page).locator("code").allTextContents()).find(ref => !beforeRefs.has(ref));
    expect(newRef).toBeTruthy();
    const pre = owner.page.locator("main pre");
    await expect(pre).toContainText('"currency": "BDT"');
    await expect(pre).toContainText('"value": 1150');
    const payload = await pre.innerText();
    expect(payload).not.toMatch(/Acquisition Fixture|01700000000|acq-fixture|never-collect|Fixture street|page_location|page_referrer/i);
    expect(payload).not.toContain(id);
    expect(bodies.every(row => !row.referer && !/never-collect|pii-fixture/.test(JSON.stringify(row.payload)))).toBeTruthy();
    expect([...externalRequests]).toEqual([]);

    await owner.page.goto(report);
    expect(await dashboard(owner.page)).toEqual({
      ...baseline, qualified: baseline.qualified + 1, productToCart: baseline.productToCart + 1,
      checkoutToOrder: baseline.checkoutToOrder + 1, codOrders: baseline.codOrders + 1, codAwaiting: baseline.codAwaiting + 1,
    });
    await owner.page.goto(report + "&market=us");
    expect(await dashboard(owner.page)).toEqual(otherMarket);
    await owner.page.goto("/staff/acquisition");
    await expect(owner.page.getByRole("heading", { name: "Live records only" })).toBeVisible();
    await expect(owner.page.getByRole("row").filter({ hasText: "Matched to an accepted order" })).toContainText("0");
    await packer.page.goto("/staff/acquisition");
    await expect(packer.page.getByRole("heading", { name: "Page not found" })).toBeVisible();

    await packer.page.goto("/staff/orders/" + id);
    await packer.page.getByRole("button", { name: "Mark packing", exact: true }).click();
    await packer.page.getByRole("button", { name: "Mark ready to ship" }).click();
    await packer.page.getByRole("textbox", { name: "Carrier", exact: true }).fill("Fixture carrier");
    await packer.page.getByRole("textbox", { name: "Tracking reference" }).fill("ACQUISITION-TEST");
    await packer.page.getByRole("button", { name: "Mark shipped" }).click();
    await packer.page.getByRole("button", { name: "Mark delivered" }).click();
    await expect(packer.page.getByText("Delivered", { exact: true }).first()).toBeVisible();
    await owner.page.goto("/staff/orders/" + id);
    await owner.page.getByRole("checkbox", { name: "I confirm the full amount was received." }).check();
    await owner.page.getByRole("button", { name: "Record collection" }).click();
    await expect(owner.page.getByText("Collected", { exact: true })).toBeVisible();

    await owner.page.goto(events);
    await expect(owner.page.getByRole("row").filter({ hasText: "COD reported collected" }).first()).toBeVisible();
    await expect(orderRows(owner.page)).toHaveCount(before + 1);
    await expect(owner.page.locator("main pre")).toHaveText(payload, { useInnerText: true });
    await screenshot(owner.page, "events");
    await owner.page.goto(report);
    await expect(owner.page.getByText("GA4 and Meta delivery are disabled.", { exact: false })).toBeVisible();
    expect(await dashboard(owner.page)).toEqual({
      ...baseline, qualified: baseline.qualified + 1, productToCart: baseline.productToCart + 1,
      checkoutToOrder: baseline.checkoutToOrder + 1, codOrders: baseline.codOrders + 1,
      delivered: baseline.delivered + 1, codCollected: baseline.codCollected + 1,
    });
    await screenshot(owner.page, "report");

    await page.getByText("Privacy choices", { exact: true }).click();
    await page.getByRole("button", { name: "Withdraw and delete measurement" }).click();
    await expect(page.getByText("Shopping measurement is off.", { exact: true })).toBeVisible();
    expect((await shopper.cookies()).some(cookie => cookie.name === "griipbuddy-measurement")).toBe(false);
    await owner.page.goto(events);
    expect(await orderRows(owner.page).locator("code").allTextContents()).not.toContain(newRef);
    await owner.page.goto(report);
    expect(await dashboard(owner.page)).toEqual({
      ...baseline, codOrders: baseline.codOrders + 1, delivered: baseline.delivered + 1, codCollected: baseline.codCollected + 1,
    });
    await page.reload();
    await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
  } finally {
    await shopper.request.post("/api/measurement", { headers: query, data: { action: "withdraw" } }).catch(() => undefined);
    if (createdId) {
      // Clean up only the fixture created by this run.
      const { getDb } = await import("../src/lib/db/client");
      const { requireLocalDatabase } = await import("../src/lib/db/local");
      requireLocalDatabase("griipbuddy_test");
      const db = getDb();
      const id = createdId;
      await db.$transaction(async tx => {
        const order = await tx.order.findUnique({ where: { id }, include: { items: true } });
        if (order?.measurementTest !== true || order.customerName !== "Acquisition Fixture") return;
        await tx.auditEvent.deleteMany({ where: { target: id } });
        await tx.fulfillmentEvent.deleteMany({ where: { orderId: id } });
        await tx.payment.delete({ where: { orderId: id } });
        await tx.orderItem.deleteMany({ where: { orderId: id } });
        await tx.order.delete({ where: { id } });
        await tx.checkoutAttempt.delete({ where: { id: order.attemptId } });
        if (!order.cancelledAt) for (const line of order.items) {
          await tx.inventory.update({ where: { variantId: line.variantId }, data: { available: { increment: line.quantity } } });
        }
      });
      await db.$disconnect();
    }
    await Promise.allSettled([shopper.close(), blocked.close(), owner.context.close(), packer.context.close()]);
  }
});
