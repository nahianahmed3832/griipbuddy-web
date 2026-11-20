import { expect, test } from "@playwright/test";
import { getDb } from "../src/lib/db/client.ts";
import { requireLocalDatabase } from "../src/lib/db/local.ts";

test.use({ trace: "off" });

test("staff can save, preview and publish a scoped recommendation draft", async ({ page, baseURL }, info) => {
  test.skip(info.project.name !== "desktop" || process.env.GRIIPBUDDY_ENV_FILE !== ".env.test", "Requires the isolated desktop test database.");
  if (baseURL !== "http://127.0.0.1:3101") throw new Error("Expected the isolated browser origin.");
  requireLocalDatabase("griipbuddy_test");
  test.setTimeout(60_000);
  const db = getDb();
  const key = "bd:default";
  expect(await db.homepageContent.count({ where: { key } })).toBe(0);
  try {
    await page.goto("/staff/login");
    await page.getByRole("textbox", { name: "Email address" }).fill(process.env.TEST_OWNER_EMAIL!);
    await page.getByLabel("Password", { exact: true }).fill(process.env.TEST_OWNER_PASSWORD!);
    await page.getByRole("button", { name: "Sign in to staff dashboard" }).click();
    await expect(page.getByRole("heading", { name: "Packing queue" })).toBeVisible();

    await page.goto("/staff/homepage?scope=bd%3Adefault");
    const editor = page.getByRole("region", { name: "Recommendations", exact: true });
    await editor.getByLabel("Use consented shopping behavior").selectOption("enabled");
    await editor.getByText("Recommended for you", { exact: true }).click();
    const placement = editor.locator("details").filter({ hasText: "Recommended for you" });
    await placement.getByRole("combobox", { name: "Strategy", exact: true }).selectOption("curated");
    await placement.getByRole("checkbox", { name: "Override inherited curated fallback products" }).check();
    await placement.getByRole("textbox", { name: "Curated fallback products", exact: true }).fill("p-tote");
    await editor.getByRole("button", { name: "Save recommendation draft" }).click();
    await expect(page.getByRole("button", { name: "Publish saved draft" })).toBeVisible();
    expect((await db.homepageContent.findUniqueOrThrow({ where: { key } })).publishedId).toBeNull();

    await editor.getByRole("link", { name: "Preview recommendations · Bangladesh" }).click();
    await expect(page.getByRole("heading", { name: "Recommendation preview" })).toBeVisible();
    await expect(page.getByText("Bangladesh · en-BD · BDT")).toBeVisible();
    await expect(page.getByText("Enabled for shoppers with consent")).toBeVisible();
    await expect(page.getByText("Curated", { exact: true })).toBeVisible();
    await expect(page.getByText("p-tote", { exact: true })).toBeVisible();
    await page.getByLabel("Shopper scenario").selectOption("returning");
    await page.getByLabel("Seed or anchor product ID").fill("p-tote");
    await page.getByRole("button", { name: "Run preview" }).click();
    await expect(page.getByLabel("Shopper scenario")).toHaveValue("returning");
    await page.setViewportSize({ width: 360, height: 800 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await page.getByRole("link", { name: "Back to editor" }).click();
    await page.getByRole("button", { name: "Publish saved draft" }).click();
    await expect(page.getByRole("heading", { name: "Publishing history" })).toBeVisible();
    await page.goto("/staff/homepage/recommendations?scope=us%3Adefault&market=us&locale=en-US");
    await expect(page.getByText("United States · en-US · USD")).toBeVisible();
    await expect(page.getByText("Disabled", { exact: true })).toBeVisible();
  } finally {
    await db.auditEvent.deleteMany({ where: { action: "MERCHANDISING_REVIEW", target: key } });
    await db.homepageContent.updateMany({ where: { key }, data: { publishedId: null } });
    await db.homepageRelease.deleteMany({ where: { scopeKey: key } });
    await db.homepageContent.deleteMany({ where: { key } });
    await db.$disconnect();
  }
});
