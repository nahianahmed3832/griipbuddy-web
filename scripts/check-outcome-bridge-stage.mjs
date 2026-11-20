import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { parse } from "dotenv";

const phase = process.argv[2];
const development = phase === "development-report";
if (phase !== "checkout" && phase !== "report" && !development) {
  throw new Error("Usage: node scripts/check-outcome-bridge-stage.mjs checkout|report|development-report <receipt>");
}
const review = new URL("../.local/market-review/", import.meta.url);
const profile = process.env.OUTCOME_BRIDGE_STAGE_ENV ?? new URL(phase === "checkout" ? "outcome-validation.env" : "app.env", review);
const env = development ? process.env : parse(await readFile(profile, "utf8"));
const origin = new URL(development ? "https://dev.griipbuddy.com" : env.BETTER_AUTH_URL);
assert.equal(origin.protocol, "https:");
assert.equal(origin.href, origin.origin + "/");
if (development) {
  assert.ok(env.QA_STAFF_EMAIL && env.QA_STAFF_PASSWORD, "Development staff access is required.");
  assert.match(env.GRIIP_DEV_EXPECTED_REVISION ?? "", /^[a-f0-9]{7,40}$/);
  assert.ok(process.argv[3], "Provide the sanitized receipt from the bridge verifier.");
} else {
  assert.match(origin.hostname, /^[a-z0-9-]+\.trycloudflare\.com$/);
  assert.equal(env.COMMERCE_MODE, "staging");
  assert.equal(env.GRIIP_MARKET_REVIEW_FIXTURES, "1");
  assert.ok(env.STAGING_USER && env.STAGING_PASSWORD);
  if (phase === "checkout") assert.equal(env.GRIIP_OUTCOME_BRIDGE_USE_LEGACY_CHECKOUT, "1");
}

const browser = await chromium.launch();
const base = development ? "/marketplace" : "";
const context = await browser.newContext({
  baseURL: origin.origin,
  serviceWorkers: "block",
  ...(!development && { httpCredentials: { username: env.STAGING_USER, password: env.STAGING_PASSWORD, origin: origin.origin } }),
});
if (development) await context.route("**/*", route => {
  const url = new URL(route.request().url());
  return url.origin === origin.origin && url.pathname.startsWith(base + "/")
    ? route.continue() : route.abort("blockedbyclient");
});
const page = await context.newPage();
page.setDefaultTimeout(25_000);
const variantId = "v-000000000000000000000005";
const orderTotal = 88_000;
const remittanceNet = orderTotal - 450;
const amount = new Intl.NumberFormat("en-BD", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const bdt = minor => `BDT ${amount.format(minor / 100)}`;

function capture(path, action) {
  return page.waitForResponse(response => {
    const request = response.request();
    return new URL(response.url()).pathname === path && request.method() === "POST" && request.postDataJSON()?.action === action;
  });
}

async function verifyCheckout() {
  await page.goto("/products/legacy-outcome-bridge-fixture?market=bd");
  await expect(page.getByRole("heading", { name: "Legacy outcome bridge fixture" })).toBeVisible();
  await page.getByText("Privacy choices", { exact: true }).click();
  const viewed = capture("/api/measurement", "PRODUCT_VIEW");
  await page.getByRole("button", { name: "Allow shopping measurement" }).click();
  const view = await viewed;
  assert.equal(view.status(), 200);
  assert.equal(view.request().postDataJSON().variantId, variantId);
  assert.equal(view.request().postDataJSON().marketId, "bd");

  const added = capture("/api/measurement", "CART_ADD");
  await page.getByRole("button", { name: "Add to cart", exact: true }).click();
  assert.equal((await added).status(), 200);
  const started = capture("/api/measurement", "CHECKOUT_START");
  await page.goto("/checkout");
  const start = await started;
  assert.equal(start.status(), 200);
  assert.equal(start.request().postDataJSON().marketId, "bd");
  await expect(page.getByText(/Test orders only/).first()).toBeVisible();
  await page.getByRole("textbox", { name: "Full name", exact: true }).fill("Bridge Staging Fixture");
  await page.getByRole("textbox", { name: "Phone number", exact: true }).fill("01700000000");
  await page.getByRole("textbox", { name: "Street address", exact: true }).fill("101 Synthetic Fixture Street");
  await page.getByRole("combobox", { name: "District", exact: true }).selectOption("dhaka");
  await page.getByRole("textbox", { name: /Area (?:or|\/) upazila/i }).fill("Dhanmondi");

  const reviewed = capture("/api/checkout", "review");
  await page.getByRole("button", { name: "Review order", exact: true }).click();
  const quote = await (await reviewed).json();
  assert.equal(quote.kind, "review");
  assert.equal(quote.quote.currency, "BDT");
  assert.equal(quote.quote.totalMinor, orderTotal);
  assert.equal(quote.quote.deliveryMinor, 8_000);
  assert.deepEqual(quote.quote.lines.map(line => [line.variantId, line.sku, line.quantity]), [[variantId, "FIXTURE-BD-BLUE", 1]]);

  const submitted = capture("/api/checkout", "submit");
  await page.getByRole("button", { name: "Place COD order", exact: true }).click();
  const submission = await submitted;
  const request = submission.request();
  const result = await submission.json();
  assert.equal(submission.status(), 200);
  assert.equal(result.kind, "placed");
  assert.equal(result.orderId, quote.attemptId);
  assert.equal(request.headers()["x-griipbuddy-measurement-session"], start.request().postDataJSON().sessionId);
  assert.equal(request.headers()["x-griip-order-handoff"], undefined);
  assert.equal(Object.hasOwn(result, "linkProof"), false);

  await page.waitForURL(`/orders/${result.orderId}`);
  await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Payment and status" }).getByText("Awaiting collection", { exact: true })).toBeVisible();
  const reference = await page.getByText(/^Order reference/).locator("strong").innerText();
  const replay = await context.request.post("/api/checkout", {
    headers: { origin: origin.origin }, data: request.postDataJSON(),
  });
  assert.equal(replay.status(), 200);
  assert.equal((await replay.json()).orderId, result.orderId);
  console.log(JSON.stringify({ attemptId: result.orderId, reference, marketId: "bd", currency: "BDT", totalMinor: quote.quote.totalMinor }));
}

async function verifyReport() {
  const passwordFile = process.env.OUTCOME_BRIDGE_STAGE_OWNER_PASSWORD_FILE ?? new URL("owner.password", review);
  const password = (await readFile(passwordFile, "utf8")).trim();
  await page.goto("/staff/login");
  const login = page.getByRole("main");
  await login.getByRole("textbox", { name: "Email address" }).fill(process.env.OUTCOME_BRIDGE_STAGE_OWNER_EMAIL ?? "review-owner@example.test");
  await login.getByLabel("Password", { exact: true }).fill(password);
  await login.getByRole("button", { name: "Sign in to staff dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Packing queue", exact: true })).toBeVisible();

  const report = "/staff/acquisition?scope=test&market=bd";
  await page.goto(report);
  const external = page.getByRole("region", { name: "External checkout outcomes", exact: true });
  const fixtureCount = Number(process.env.OUTCOME_BRIDGE_STAGE_EXPECTED_ORDERS ?? 1);
  assert.ok(Number.isSafeInteger(fixtureCount) && fixtureCount > 0);
  const metric = label => external.getByText(label, { exact: true }).locator("..").locator("dd");
  for (const label of ["Orders booked", "Delivered", "COD collected", "Matched remittances"]) {
    await expect(metric(label).first()).toHaveText(String(fixtureCount));
  }
  await expect(metric("COD collected").last()).toHaveText(bdt(orderTotal * fixtureCount));
  await expect(metric("Matched remittances").last()).toHaveText(`${bdt(remittanceNet * fixtureCount)} net`);

  await page.goto(report + "&view=events");
  for (const label of ["Order accepted", "Order delivered", "COD reported collected", "COD remittance matched"]) {
    const rows = page.getByRole("row").filter({ hasText: "legacy-checkout" }).filter({ hasText: label });
    await expect(rows).toHaveCount(Number(fixtureCount));
  }
  for (const scope of ["scope=live&market=bd", "scope=test&market=us"]) {
    await page.goto(`/staff/acquisition?${scope}&view=events`);
    await expect(page.getByRole("heading", { name: "Recent events", exact: true })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: "legacy-checkout" })).toHaveCount(0);
  }
  console.log("Staging Bangladesh report shows all four verified outcomes with no matching records in live or US scope.");
}

async function verifyDevelopmentReport() {
  const receipt = JSON.parse(await readFile(process.argv[3], "utf8"));
  assert.match(receipt.authority, /^legacy-checkout-dev-[a-z0-9]{6,24}$/);
  assert.equal(receipt.marketId, "bd");
  assert.equal(receipt.evidence, "fixture");
  assert.ok(Array.isArray(receipt.orders) && receipt.orders.length > 0 && receipt.orders.length <= 100);
  const staff = await context.request.post(base + "/api/staff/sign-in", {
    headers: { origin: origin.origin }, maxRedirects: 0,
    data: { email: env.QA_STAFF_EMAIL, password: env.QA_STAFF_PASSWORD },
  });
  assert.equal(staff.status(), 200, "Development staff sign-in was rejected.");
  const report = base + "/staff/acquisition";
  for (const order of receipt.orders) {
    assert.equal(order.currency, "BDT");
    assert.match(order.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.deepEqual(order.events.map(event => event.kind),
      ["ORDER_ACCEPTED", "ORDER_DELIVERED", "COD_COLLECTED", "COD_REMITTED"]);
    const ids = order.events.map(event => event.reference);
    assert.ok(ids.every(id => /^[a-f0-9]{12}$/.test(id)) && new Set(ids).size === ids.length);
    const dates = "&from=" + order.day + "&to=" + order.day;
    await page.goto(report + "?scope=test&market=bd" + dates);
    await expect(page.getByRole("region", { name: "External checkout outcomes", exact: true })).toBeVisible();
    await page.goto(report + "?scope=test&market=bd&view=events" + dates);
    const rows = page.getByRole("row").filter({ hasText: receipt.authority });
    for (const [index, event] of order.events.entries()) {
      const row = rows.filter({ has: page.getByText(ids[index], { exact: true }) });
      await expect(row).toHaveCount(1);
      if (event.amountMinor !== null) await expect(row).toContainText(bdt(event.amountMinor));
    }
    for (const scope of ["scope=live&market=bd", "scope=test&market=us"]) {
      await page.goto(report + "?" + scope + "&view=events" + dates);
      await expect(page.getByRole("heading", { name: "Recent events", exact: true })).toBeVisible();
      for (const id of ids) await expect(page.getByText(id, { exact: true })).toHaveCount(0);
    }
  }
  console.log(JSON.stringify({ verified: receipt.orders.length, market: "bd", evidence: "fixture", isolatedFromLiveAndUS: true }));
}

try {
  const health = await context.request.get(base + "/api/health", { maxRedirects: 0 });
  assert.equal(health.status(), 200);
  const service = await health.json();
  const { visibility, orderIntake } = service;
  assert.deepEqual({ visibility, orderIntake }, {
    visibility: "marketplace-preview", orderIntake: "test-only",
  });
  if (development) {
    assert.equal(service.revision, env.GRIIP_DEV_EXPECTED_REVISION);
    assert.equal(service.database, "ok");
    await verifyDevelopmentReport();
  } else await (phase === "checkout" ? verifyCheckout() : verifyReport());
} finally {
  await browser.close();
}
