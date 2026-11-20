import { randomUUID } from "node:crypto";
import { expect, test, type Page, type Route } from "@playwright/test";
import type { BrowserMeasurement } from "../src/lib/measurement/schema";

const local = !process.env.GRIIPBUDDY_STAGE_URL && process.env.GRIIPBUDDY_ENV_FILE === ".env.test";
test.skip(!local, "Requires the isolated local database and checkout origin.");
test.use({ trace: "off" });

function measurements(page: Page) {
  const events: BrowserMeasurement[] = [];
  page.on("response", response => {
    if (!response.ok() || !response.url().endsWith("/api/measurement") || response.request().method() !== "POST") return;
    const event = response.request().postDataJSON();
    if (event.version === 1) events.push(event);
  });
  return events;
}

async function allowMeasurement(page: Page) {
  await page.getByText("Privacy choices", { exact: true }).click();
  await page.getByRole("button", { name: "Allow shopping measurement" }).click();
  await expect(page.getByText("Your choice was saved.", { exact: true })).toBeVisible();
}

test("records visible product placements and completed searches only after consent", async ({ page }) => {
  const events = measurements(page);
  await page.goto("/?utm_source=newsletter");
  await expect(page.locator("h1").first()).toBeVisible();
  expect(events).toHaveLength(0);
  await allowMeasurement(page);
  await page.locator("h1").first().scrollIntoViewIfNeeded();
  await expect.poll(() => events.some(event => event.action === "HOMEPAGE_SECTION_IMPRESSION" &&
    event.homepageConfig && event.campaignSource === "newsletter")).toBe(true);

  await page.goto("/shop");
  const cards = page.locator(".product-grid .product-card");
  await expect.poll(() => cards.count()).toBeGreaterThan(5);
  const first = cards.first();
  const last = cards.last();
  const variant = (href: string | null) => new URL(href!, page.url()).searchParams.get("variant");
  const firstVariant = variant(await first.getAttribute("href"));
  const lastVariant = variant(await last.getAttribute("href"));
  const impressions = (id: string | null) => events.filter(event => event.action === "PRODUCT_IMPRESSION" &&
    event.placement === "shop" && event.variantId === id);
  await first.scrollIntoViewIfNeeded();
  await expect.poll(() => impressions(firstVariant).length).toBe(1);
  expect(impressions(lastVariant)).toHaveLength(0);
  await last.scrollIntoViewIfNeeded();
  await expect.poll(() => impressions(lastVariant).length).toBe(1);
  const lastCard = impressions(lastVariant)[0];
  expect(lastCard).toMatchObject({ marketId: "bd", currency: "BDT", displayedPriceMinor: expect.any(Number), position: await cards.count() });

  await last.click();
  await expect(page).toHaveURL(/\/products\//);
  await expect.poll(() => events.some(event => event.action === "PRODUCT_CLICK" && event.variantId === lastVariant &&
    event.sessionId === lastCard.sessionId)).toBe(true);
  await expect.poll(() => events.some(event => event.action === "PRODUCT_VIEW" && event.variantId === lastVariant &&
    event.sessionId === lastCard.sessionId)).toBe(true);

  await page.goto("/search?q=canvas");
  await expect.poll(() => events.find(event => event.action === "SEARCH" && event.query === "canvas")?.resultCount ?? 0).toBeGreaterThan(0);
  if (!process.env.TEST_MEASUREMENT_MARKETPLACE) {
    const trigger = page.getByRole("button", { name: "Filters", exact: true });
    const mobile = await trigger.isVisible();
    if (mobile) await trigger.click();
    const filters = page.getByRole(mobile ? "dialog" : "complementary", { name: "Filters", exact: true });
    await filters.getByRole("checkbox", { name: "In stock", exact: true }).check();
    await filters.getByRole("button", { name: "Apply filters" }).click();
    await expect.poll(() => events.some(event => event.action === "SEARCH_FILTER" && event.query === "canvas" &&
      event.filters?.availability === "in-stock")).toBe(true);

    // Hold a consented preceding analytics request so only navigation flushing
    // can deliver the following product click across the document boundary.
    let held: Route | undefined;
    await page.route("**/api/measurement", async route => {
      const request = route.request();
      if (request.method() === "POST" && request.postDataJSON()?.action === "SEARCH_FILTER") held = route;
      else await route.continue();
    });
    await page.getByRole("link", { name: "Clear filters", exact: true }).click();
    await expect.poll(() => Boolean(held)).toBe(true);
    const tote = page.locator(".product-card").filter({ hasText: "Canvas Carryall Tote" });
    await tote.click();
    await expect(page).toHaveURL(/\/products\/canvas-carryall-tote/);
    const { getDb } = await import("../src/lib/db/client");
    // Chromium can stop delivering the old document response to Playwright.
    // Verify the keepalive result in the destination database.
    await expect.poll(() => getDb().measurementEvent.count({ where: {
      kind: "PRODUCT_CLICK", placement: "search-results", productId: "p-tote", variantId: null, sessionId: lastCard.sessionId,
    } })).toBe(1);
    await held?.abort().catch(() => {});
    await page.unroute("**/api/measurement");
  }

  await page.goto("/search?q=measurementnomatchzz");
  await expect.poll(() => events.find(event => event.action === "SEARCH" && event.query === "measurementnomatchzz")?.resultCount).toBe(0);
  const searched = events.filter(event => event.action === "SEARCH").length;
  await page.goto("/search?q=measurement-fixture%40example.test");
  await expect.poll(() => events.filter(event => event.action === "SEARCH").length).toBe(searched + 1);
  expect(events.filter(event => event.action === "SEARCH").at(-1)).toMatchObject({ resultCount: 0, sessionId: lastCard.sessionId });
  expect(events.filter(event => event.action === "SEARCH").at(-1)).not.toHaveProperty("query");

  await page.getByText("Privacy choices", { exact: true }).click();
  await page.getByRole("button", { name: "Withdraw and delete measurement" }).click();
  await expect(page.getByText("Shopping measurement is off.", { exact: true })).toBeVisible();
  const recorded = events.length;
  await page.goto("/search?q=canvas");
  await expect(page.getByText("Privacy choices", { exact: true })).toBeVisible();
  expect(events).toHaveLength(recorded);
  expect(await page.evaluate(() => sessionStorage.getItem("griipbuddy:measurement-session"))).toBeNull();
});

test("associates a consented anonymous session after authentication and measures wishlist mutations", async ({ page, baseURL }, info) => {
  test.skip(process.env.TEST_MEASUREMENT_MARKETPLACE !== "1" || info.project.name !== "desktop", "Requires marketplace test mode.");
  if (baseURL !== "http://127.0.0.1:3101") throw new Error("Expected the isolated local origin.");
  const events = measurements(page);
  const email = `measurement-fixture-${randomUUID()}@example.test`;
  const password = randomUUID();
  const headers = { Origin: baseURL };
  const path = "/products/canvas-carryall-tote?variant=v-tote-oat";
  const { getDb } = await import("../src/lib/db/client");
  const db = getDb();
  try {
    await page.goto(path);
    await allowMeasurement(page);
    await expect.poll(() => events.find(event => event.action === "PRODUCT_VIEW")?.sessionId).toBeTruthy();
    const anonymous = events.find(event => event.action === "PRODUCT_VIEW")?.sessionId;
    expect(events.some(event => event.action === "ACCOUNT_ASSOCIATED")).toBe(false);
    const signedUp = await page.request.post("/api/shopper-auth/sign-up/email", { headers, data: { name: "Measurement Fixture", email, password } });
    expect(signedUp.ok()).toBe(true);
    const signedIn = await page.request.post("/api/shopper-auth/sign-in/email", { headers, data: { email, password } });
    expect(signedIn.ok()).toBe(true);

    await page.reload();
    await expect.poll(() => events.find(event => event.action === "ACCOUNT_ASSOCIATED")?.sessionId).toBe(anonymous);
    await page.getByRole("button", { name: "Add Canvas Carryall Tote to favorites", exact: true }).click();
    await expect.poll(() => events.some(event => event.action === "WISHLIST_ADD" && event.productId === "p-tote" && event.sessionId === anonymous)).toBe(true);
    await page.getByRole("button", { name: "Remove Canvas Carryall Tote from favorites", exact: true }).click();
    await expect.poll(() => events.some(event => event.action === "WISHLIST_REMOVE" && event.productId === "p-tote" && event.sessionId === anonymous)).toBe(true);
    expect(JSON.stringify(events)).not.toContain(email);

    const [associated, guestView, member] = await Promise.all([
      db.measurementEvent.findFirst({ where: { kind: "ACCOUNT_ASSOCIATED", sessionId: anonymous } }),
      db.measurementEvent.findFirst({ where: { kind: "PRODUCT_VIEW", sessionId: anonymous }, orderBy: { at: "asc" } }),
      db.shopper.findUnique({ where: { email }, select: { id: true } }),
    ]);
    expect(associated?.sessionId).toBe(anonymous);
    expect(associated?.accountKey).toMatch(/^[a-f0-9]{64}$/);
    expect(associated?.accountKey).not.toBe(member?.id);
    expect(guestView?.accountKey).toBeNull();
  } finally {
    await page.request.post("/api/measurement", { headers, data: { action: "withdraw" } });
    await db.shopper.deleteMany({ where: { email } });
  }
});
