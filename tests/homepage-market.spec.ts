import { expect, test } from "@playwright/test";
import { recentHistoryKey } from "../src/lib/catalog/recent-history.ts";
import { getDb } from "../src/lib/db/client.ts";
import { requireLocalDatabase } from "../src/lib/db/local.ts";

test.use({ trace: "off" });

test("owners can draft, schedule, publish and restore homepages in two locales", async ({ browser, page, baseURL }, info) => {
  test.skip(info.project.name !== "desktop" || process.env.GRIIPBUDDY_ENV_FILE !== ".env.test", "Requires the isolated desktop test database.");
  if (baseURL !== "http://127.0.0.1:3101") throw new Error("Expected the isolated browser origin.");
  requireLocalDatabase("griipbuddy_test");
  test.setTimeout(75_000);
  const db = getDb();
  const settings = [
    { market: "bd", locale: "en-BD", country: "Bangladesh", timeZone: "Asia/Dhaka" },
    { market: "us", locale: "en-US", country: "United States", timeZone: "America/New_York" },
  ] as const;
  const scopes = settings.map(market => `${market.market}:${market.locale}`);
  expect(await db.homepageContent.count({ where: { key: { in: scopes } } })).toBe(0);
  const publicContext = await browser.newContext({ baseURL, viewport: { width: 320, height: 780 }, isMobile: true, hasTouch: true });
  const storefront = await publicContext.newPage();
  try {
    await page.goto("/staff/login");
    const signIn = page.getByRole("main");
    await signIn.getByRole("textbox", { name: "Email address" }).fill(process.env.TEST_OWNER_EMAIL!);
    await signIn.getByLabel("Password", { exact: true }).fill(process.env.TEST_OWNER_PASSWORD!);
    await signIn.getByRole("button", { name: "Sign in to staff dashboard" }).click();
    await expect(page.getByRole("heading", { name: "Packing queue" })).toBeVisible();

    for (const { market, country, locale, timeZone } of settings) {
      const office = `/staff/homepage?scope=${encodeURIComponent(`${market}:${locale}`)}`;
      const publicHome = `/?market=${market}&lang=${locale}`;
      const preview = page.getByRole("link", { name: `Preview ${country} · ${locale}` });
      const title = `${country} scheduled fixture`;
      await page.goto(office);
      await expect(page.getByRole("heading", { name: "Homepage merchandising" })).toBeVisible();
      await page.getByRole("button", { name: "Add section" }).click();
      await page.getByLabel("Section key", { exact: true }).fill("hero");
      await page.getByLabel("Title", { exact: true }).fill(title);
      await page.getByLabel("Starts in market local time").fill("2027-01-15T09:00");
      await page.getByLabel("Ends in market local time").fill("2027-01-15T11:00");
      await page.getByRole("button", { name: "Save draft" }).click();
      await expect(preview).toBeVisible();

      await storefront.goto(publicHome);
      await expect(storefront.getByRole("heading", { level: 1 })).toHaveText("Essentials for every day");
      await expect(storefront.locator("html")).toHaveAttribute("lang", locale);

      await preview.click();
      await expect(page.getByText(`${country} · ${locale} · ${timeZone}`, { exact: true })).toBeVisible();
      await page.getByLabel("Preview at market local time").fill("2027-01-15T08:59");
      await page.getByRole("button", { name: "Update preview" }).click();
      await expect(page.getByRole("heading", { name: "Essentials for every day" })).toBeVisible();
      await page.getByLabel("Preview at market local time").fill("2027-01-15T09:00");
      await page.getByRole("button", { name: "Update preview" }).click();
      await expect(page.getByRole("heading", { name: title })).toBeVisible();

      await page.getByRole("link", { name: "Back to editor" }).click();
      await page.getByLabel("Starts in market local time").fill("");
      await page.getByLabel("Ends in market local time").fill("");
      await page.getByRole("button", { name: "Save draft" }).click();
      await expect.poll(async () => (await db.homepageContent.findUnique({ where: { key: `${market}:${locale}` } }))?.revision).toBe(2);
      await page.getByRole("button", { name: "Publish saved draft" }).click();
      await expect(page.getByRole("heading", { name: "Publishing history" })).toBeVisible();

      await storefront.goto(publicHome);
      await expect(storefront.getByRole("heading", { level: 1 })).toHaveText(title);
      expect(await storefront.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    }

    const first = settings[0];
    await page.goto(`/staff/homepage?scope=${encodeURIComponent(`${first.market}:${first.locale}`)}`);
    await page.getByLabel("Title", { exact: true }).fill("Temporary replacement fixture");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect.poll(async () => (await db.homepageContent.findUnique({ where: { key: scopes[0] } }))?.revision).toBe(4);
    await page.getByRole("button", { name: "Publish saved draft" }).click();
    await page.getByRole("button", { name: "Restore version" }).click();
    await expect.poll(async () => (await db.homepageContent.findUnique({ where: { key: scopes[0] }, include: { published: true } }))?.published?.restoredFrom).toBeTruthy();
    for (const { market, country, locale } of settings) {
      await storefront.goto(`/?market=${market}&lang=${locale}`);
      await expect(storefront.getByRole("heading", { level: 1 })).toHaveText(`${country} scheduled fixture`);
    }
  } finally {
    await publicContext.close();
    await db.homepageContent.updateMany({ where: { key: { in: scopes } }, data: { publishedId: null } });
    await db.homepageRelease.deleteMany({ where: { scopeKey: { in: scopes } } });
    await db.homepageContent.deleteMany({ where: { key: { in: scopes } } });
    await db.$disconnect();
  }
});

test("optional personalization respects unpublished market policies and measurement withdrawal", async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== "desktop" || process.env.GRIIPBUDDY_ENV_FILE !== ".env.test" ||
    process.env.ACQUISITION_MEASUREMENT !== "1", "Requires local opted-in market tracking.");
  if (baseURL !== "http://127.0.0.1:3101") throw new Error("Expected the isolated browser origin.");
  const product = "/products/canvas-carryall-tote";
  const bd = recentHistoryKey("bd", "");
  const us = recentHistoryKey("us", "");
  const stored = (prefix: string) => page.evaluate(value => Object.keys(localStorage).filter(name => name.startsWith(value)), prefix);
  await page.goto(product + "?market=bd");
  await page.getByText("Privacy choices", { exact: true }).click();
  await page.getByRole("button", { name: "Allow shopping measurement" }).click();
  expect(await stored(bd)).toHaveLength(0);
  await page.getByRole("button", { name: "Allow personalized recommendations" }).click();
  await expect(page.getByText("Personalized recommendations are on.", { exact: true })).toBeVisible();
  expect(await stored(bd)).toHaveLength(0);
  expect(await stored(us)).toHaveLength(0);

  await page.goto(product + "?market=us");
  expect(await stored(us)).toHaveLength(0);

  await page.goto("/search?market=us");
  await page.getByText("Privacy choices", { exact: true }).click();
  await page.getByRole("button", { name: "Withdraw and delete measurement" }).click();
  await expect(page.getByText("Shopping measurement is off.", { exact: true })).toBeVisible();
  expect(await stored(bd)).toHaveLength(0);
  expect(await stored(us)).toHaveLength(0);
});
