import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { formatMoney, markets } from "../src/config/markets";
import { storefrontPath } from "../src/config/storefront-path";
import { defaultHomepage, scopeKey, type HomepageScope, type HomepageSection } from "../src/lib/catalog/homepage-contract";
import type { homepageReadPayload } from "../src/lib/catalog/homepage-layout";
import { getDb } from "../src/lib/db/client";
import { requireLocalDatabase } from "../src/lib/db/local";
import type { BrowserMeasurement } from "../src/lib/measurement/schema";
import { saveHomepageDraft } from "../src/lib/staff/homepage";

type PublishedHome = Awaited<ReturnType<typeof homepageReadPayload>>;
const inheritedBody = defaultHomepage.sections.filter(section => section.key !== "hero").map(section => section.key);

test.use({ trace: "off" });

function pathForMarket(market: (typeof markets)[keyof typeof markets], path = "/") {
  return storefrontPath(`${path}?${new URLSearchParams({ market: market.id, lang: market.locale })}`);
}

function authoredSections(market: (typeof markets)[keyof typeof markets]): HomepageSection[] {
  const label = market.countryCode;
  return [
    { key: "fixture-categories", type: "DEPARTMENTS", position: 10, title: `${label} fixture categories`, categoryIds: ["d-fashion", "d-electronics"] },
    { key: "fixture-collections", type: "COLLECTIONS", position: 20, title: `${label} fixture collections`, collectionIds: ["c-carry", "c-home"] },
    { key: "fixture-featured", type: "FEATURED", position: 30, title: `${label} fixture selections`, description: "A saved editorial selection.",
      productIds: ["p-glass", "p-brush", "p-stand", "p-lamp"] },
    { key: "fixture-spotlight", type: "CATEGORY_SPOTLIGHT", position: 40, title: `${label} fixture spotlight`, categoryId: "d-sports", limit: 2 },
    { key: "fixture-new", type: "NEW", position: 50, title: `${label} fixture arrivals` },
    { key: "fixture-deals", type: "DEALS", position: 60, title: `${label} fixture offers`,
      budget: market.id === "us" ? { currency: "USD", amountMinor: 1_200 } : undefined },
    { key: "fixture-disabled", type: "FEATURED", position: 70, title: "Disabled fixture section", productIds: ["p-cushion"], enabled: false },
    { key: "fixture-expired", type: "FEATURED", position: 80, title: "Expired fixture section", productIds: ["p-cushion"], endsLocal: "2025-01-01T00:00" },
    { key: "fixture-empty", type: "CURATED", position: 90, title: "Empty fixture section", productIds: ["p-tote"] },
  ];
}

async function loopbackOnly(context: BrowserContext, origin: string) {
  await context.route("**/*", route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
}

async function published(page: Page, market: (typeof markets)[keyof typeof markets]) {
  const response = await page.request.get(pathForMarket(market, "/api/storefront/homepage"), { maxRedirects: 0 });
  expect(response.ok()).toBe(true);
  expect(response.headers()["cache-control"]).toMatch(/private.*no-store/);
  return await response.json() as PublishedHome;
}

function sameProductLink(actual: string | null, expected: string, origin: string) {
  if (!actual) return false;
  const resolved = new URL(actual, origin);
  const reference = new URL(expected, origin);
  return `${resolved.pathname}?${new URLSearchParams([...resolved.searchParams].sort())}` ===
    `${reference.pathname}?${new URLSearchParams([...reference.searchParams].sort())}`;
}

async function verifyBody(page: Page, payload: PublishedHome, origin: string, mobile: boolean, verifyDestinations: boolean) {
  const market = markets[payload.marketId];
  const main = page.getByRole("main");
  await expect(main.getByRole("heading", { level: 1 })).toHaveText("Essentials for every day");
  await expect(page.locator("html")).toHaveAttribute("lang", payload.locale);
  await expect(main.locator("section h2")).toHaveText(payload.sections.map(section => section.title));
  await expect(main.getByRole("search")).toHaveCount(0);
  await expect(main.getByRole("button", { name: /^(Filters|Apply filters|Edit section)$/ })).toHaveCount(0);
  expect(payload.currency).toBe(market.currency);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);

  const destinations = new Set<string>();
  for (const section of payload.sections) {
    const region = main.getByRole("region", { name: section.title, exact: true });
    const bodyLinks = await region.getByRole("link").evaluateAll(links => links.map(link => link.getAttribute("href")));
    const products = region.locator(".product-grid .product-card");
    await expect(products).toHaveCount(section.products.length);
    for (const [index, product] of section.products.entries()) {
      const card = products.nth(index);
      await expect(card.getByRole("heading", { name: product.name, exact: true })).toBeVisible();
      expect(sameProductLink(await card.getAttribute("href"), product.href, origin)).toBe(true);
      await expect(card.locator(".product-card__price")).toContainText(formatMoney(product.amountMinor, { ...market, locale: payload.locale }));
      if (product.promotionEndsAt && product.regularMinor > product.amountMinor) {
        await expect(card.locator("del")).toHaveText(formatMoney(product.regularMinor, { ...market, locale: payload.locale }));
      }
      const image = card.locator("img");
      await expect(image).toHaveAttribute("alt", product.image.alt);
      const imageUrl = new URL((await image.getAttribute("src"))!, origin);
      expect(imageUrl.searchParams.get("url") ?? `${imageUrl.pathname}${imageUrl.search}`).toBe(product.image.src);
      destinations.add(product.href);
    }
    for (const item of [...section.categories, ...section.collections]) {
      expect(bodyLinks.some(href => href && sameProductLink(href, item.href, origin))).toBe(true);
      if (section.type === "DEPARTMENTS" || section.type === "COLLECTIONS") {
        await expect(region.getByRole("link", { name: item.name, exact: true })).toBeVisible();
      }
      await expect(region.getByRole("img", { name: item.image!.alt, exact: true }).first()).toBeVisible();
      destinations.add(item.href);
    }
    if (section.destination) {
      const destination = region.getByRole("link", { name: `${section.destination.label}: ${section.title}`, exact: true });
      expect(sameProductLink(await destination.getAttribute("href"), section.destination.href, origin)).toBe(true);
      destinations.add(section.destination.href);
    }
    if (section.id === "fixture-featured" && mobile) {
      const firstTwo = await products.evaluateAll(cards => cards.slice(0, 2).map(card => {
        const bounds = card.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y };
      }));
      expect(firstTwo[0].y).toBe(firstTwo[1].y);
      expect(firstTwo[0].x).toBeLessThan(firstTwo[1].x);
    }
  }
  const parents = payload.sections.flatMap(section => section.products.map(product => product.id));
  expect(new Set(parents).size).toBe(parents.length);
  expect(parents).not.toContain("p-tote");
  if (verifyDestinations) {
    for (const href of destinations) {
      const requested = new URL(href, origin);
      expect(requested.origin).toBe(origin);
      const response = await page.request.get(requested.href, { maxRedirects: 0 });
      expect(response.status(), href).toBe(200);
      const content = new URL(response.url());
      expect(content.pathname).toBe(requested.pathname);
      expect(content.searchParams.get("market")).toBe(market.id);
      expect(content.searchParams.get("lang")).toBe(market.locale);
      expect(content.searchParams.get("variant")).toBe(requested.searchParams.get("variant"));
      expect(await response.text(), href).not.toContain(">Page not found<");
    }
  }
}

test("published merchandising matches the customer homepage in both markets and viewports", async ({ browser, page, baseURL }, info) => {
  test.skip(info.project.name !== "desktop" || process.env.GRIIPBUDDY_ENV_FILE !== ".env.test" ||
    process.env.TEST_HOMEPAGE_BODY !== "1", "Requires the isolated Homepage body browser profile.");
  if (baseURL !== "http://127.0.0.1:3101" || process.env.GRIIPBUDDY_STAGE_URL) throw new Error("Expected the isolated browser origin.");
  requireLocalDatabase("griipbuddy_test");
  test.setTimeout(180_000);
  const db = getDb();
  const scopes: HomepageScope[] = [{ marketId: "bd", locale: "en-BD" }, { marketId: "us", locale: "en-US" }];
  const keys = scopes.map(scopeKey);
  const checkout = await db.checkoutPolicy.findUniqueOrThrow({ where: { marketId: "us" } });
  const promotionKey = { variantId_marketId: { variantId: "v-bands-mauve", marketId: "bd" as const } };
  const promotion = await db.marketOffer.findUniqueOrThrow({ where: promotionKey });
  const owner = await db.staffAccess.findFirstOrThrow({ where: { role: "OWNER", active: true } });
  expect(await db.homepageContent.count({ where: { key: { in: keys } } })).toBe(0);
  const mobile = await browser.newContext({ baseURL, viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true });
  const staff = await browser.newContext({ baseURL });
  await Promise.all([loopbackOnly(page.context(), baseURL), loopbackOnly(mobile, baseURL), loopbackOnly(staff, baseURL)]);
  const phone = await mobile.newPage();
  const staffPage = await staff.newPage();
  const events: BrowserMeasurement[] = [];
  page.on("response", response => {
    if (!response.ok() || !response.url().endsWith("/api/measurement") || response.request().method() !== "POST") return;
    const event = response.request().postDataJSON();
    if (event.version === 1) events.push(event);
  });
  let measurementAllowed = false;
  try {
    await db.checkoutPolicy.update({ where: { marketId: "us" }, data: {
      enabled: true, codEnabled: true, taxTreatment: "MERCHANDISE_RATE", taxBasisPoints: 500, taxLabel: "Fixture tax",
    } });
    await db.deliveryZone.create({ data: {
      marketId: "us", district: "wa", districtLabel: "Washington", method: "body-fixture", label: "Fixture delivery", chargeMinor: 350,
    } });
    await db.marketOffer.update({ where: promotionKey, data: {
      discountMinor: 2_000, discountStartsAt: new Date(Date.now() - 60_000), discountEndsAt: new Date(Date.now() + 3_600_000),
    } });
    await staffPage.goto(storefrontPath("/staff/login"));
    const signIn = staffPage.getByRole("main");
    await signIn.getByRole("textbox", { name: "Email address" }).fill(process.env.TEST_OWNER_EMAIL!);
    await signIn.getByLabel("Password", { exact: true }).fill(process.env.TEST_OWNER_PASSWORD!);
    await signIn.getByRole("button", { name: "Sign in to staff dashboard" }).click();
    await expect(staffPage.getByRole("heading", { name: "Packing queue" })).toBeVisible();

    for (const market of [markets.bd, markets.us]) {
      const key = scopeKey({ marketId: market.id, locale: market.locale });
      const sections = authoredSections(market);
      const baseline = await published(page, market);
      await saveHomepageDraft(owner.userId, { marketId: market.id, locale: market.locale }, 0, {
        sections, hiddenSections: inheritedBody, recommendations: { placements: { recommended: { enabled: false } } },
      });
      await page.goto(pathForMarket(market));
      await expect(page.getByRole("heading", { name: sections[0].title, exact: true })).toHaveCount(0);
      expect((await published(page, market)).homepageConfig).toBe(baseline.homepageConfig);
      await staffPage.goto(storefrontPath(`/staff/homepage?scope=${encodeURIComponent(key)}`));
      await staffPage.getByRole("button", { name: "Publish saved draft" }).click();
      await expect(staffPage.getByRole("heading", { name: "Publishing history" })).toBeVisible();
      await expect.poll(async () => (await published(page, market)).homepageConfig).not.toBe(baseline.homepageConfig);
      const payload = await published(page, market);
      expect(payload.marketId).toBe(market.id);
      expect(payload.sections.map(section => section.id)).toEqual(sections.slice(0, 6).map(section => section.key));
      const deals = payload.sections.find(section => section.id === "fixture-deals")!.products;
      if (market.id === "us") expect(deals.every(product => product.amountMinor <= 1_200)).toBe(true);
      else expect(deals).toEqual(expect.arrayContaining([expect.objectContaining({ id: "p-bands", promotionEndsAt: expect.any(String) })]));
      if (market.id === "us") expect(payload.sections.flatMap(section => section.products).some(product => product.id === "p-lamp")).toBe(false);
      await page.goto(pathForMarket(market));
      await phone.goto(pathForMarket(market));
      await verifyBody(page, payload, baseURL, false, true);
      await verifyBody(phone, payload, baseURL, true, false);
      await expect(page.getByRole("heading", { name: new RegExp(`^${market.id === "bd" ? "US" : "BD"} fixture`) })).toHaveCount(0);
    }

    await page.goto(pathForMarket(markets.bd));
    const header = page.getByRole("banner");
    await expect(header.getByRole("navigation", { name: "Shop navigation" })).toBeVisible();
    const search = header.getByRole("searchbox", { name: "Search products", exact: true });
    await search.fill("canvas");
    await search.press("Enter");
    await expect(page).toHaveURL(/\/search\?/);
    await page.goto(pathForMarket(markets.bd));
    await header.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Sign in" })).toBeVisible();
    await page.keyboard.press("Escape");
    await header.getByRole("link", { name: /^Cart,/ }).press("Enter");
    await expect(page).toHaveURL(/\/cart(?:[?#]|$)/);
    await page.goto(pathForMarket(markets.bd));
    expect(events).toHaveLength(0);

    await page.getByText("Privacy choices", { exact: true }).click();
    await page.getByRole("button", { name: "Allow shopping measurement" }).click();
    await expect(page.getByText("Your choice was saved.", { exact: true })).toBeVisible();
    measurementAllowed = true;
    const featured = page.getByRole("region", { name: "BD fixture selections", exact: true });
    const title = featured.getByRole("heading", { name: "BD fixture selections" });
    await title.scrollIntoViewIfNeeded();
    const impressions = () => events.filter(event => event.action === "HOMEPAGE_SECTION_IMPRESSION" && event.sectionId === "fixture-featured");
    await expect.poll(() => impressions().length).toBe(1);
    await page.getByRole("heading", { level: 1 }).scrollIntoViewIfNeeded();
    await title.scrollIntoViewIfNeeded();
    const card = featured.locator(".product-card").first();
    const productUrl = new URL((await card.getAttribute("href"))!, baseURL);
    await card.press("Enter");
    await expect(page).toHaveURL(productUrl.href);
    const clicks = () => events.filter(event => event.action === "PRODUCT_CLICK" && event.sectionId === "fixture-featured");
    await expect.poll(() => clicks().length).toBe(1);
    const click = clicks()[0];
    expect(click).toMatchObject({ marketId: "bd", placement: "home-featured", currency: "BDT", variantId: productUrl.searchParams.get("variant") });
    expect(impressions()).toHaveLength(1);
    await expect.poll(() => db.measurementEvent.count({ where: {
      sessionId: click.sessionId, kind: "PRODUCT_CLICK", productId: click.productId,
      details: { path: ["sectionId"], equals: "fixture-featured" },
    } })).toBe(1);
  } finally {
    if (measurementAllowed) {
      await page.request.post(storefrontPath("/api/measurement"), { headers: { Origin: baseURL }, data: { action: "withdraw" }, maxRedirects: 0, timeout: 3_000 }).catch(() => undefined);
    }
    await Promise.all([mobile.close(), staff.close()]);
    await db.homepageContent.updateMany({ where: { key: { in: keys } }, data: { publishedId: null } });
    await db.homepageRelease.deleteMany({ where: { scopeKey: { in: keys } } });
    await db.homepageContent.deleteMany({ where: { key: { in: keys } } });
    await db.auditEvent.deleteMany({ where: { actorId: owner.userId, target: { in: keys } } });
    await db.deliveryZone.deleteMany({ where: { marketId: "us", district: "wa", method: "body-fixture" } });
    await db.checkoutPolicy.update({ where: { marketId: "us" }, data: {
      enabled: checkout.enabled, codEnabled: checkout.codEnabled, taxTreatment: checkout.taxTreatment,
      taxBasisPoints: checkout.taxBasisPoints, taxLabel: checkout.taxLabel,
    } });
    await db.marketOffer.update({ where: promotionKey, data: {
      discountMinor: promotion.discountMinor, discountStartsAt: promotion.discountStartsAt, discountEndsAt: promotion.discountEndsAt,
    } });
    await db.$disconnect();
  }
});
