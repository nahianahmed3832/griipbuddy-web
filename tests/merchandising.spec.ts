import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const hosted = process.env.GRIIPBUDDY_STAGE_URL;
const evidence = process.env.GRIIP_MERCHANDISING_EVIDENCE;
const url = "/staff/catalog/merchandising";
test.skip(!hosted || !evidence, "Runs against the isolated Hostinger merchandising release.");
test.use({
  launchOptions: process.env.GRIIP_BRAVE_EXECUTABLE ? { executablePath: process.env.GRIIP_BRAVE_EXECUTABLE } : {},
  trace: "off",
});

async function screenshot(page: Page, name: string, detail = false) {
  const path = evidence!;
  await mkdir(path, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  if (detail) await page.locator("#product-preview").screenshot({ path: `${path}/${name}.png`, animations: "disabled" });
  else await page.screenshot({ path: `${path}/${name}.png`, animations: "disabled" });
}

async function signIn(page: Page, role: "OWNER" | "PACKER") {
  await page.goto("/staff/login");
  await page.getByLabel("Email address", { exact: true }).fill(process.env[`TEST_${role}_EMAIL`]!);
  await page.getByLabel("Password", { exact: true }).fill(process.env[`TEST_${role}_PASSWORD`]!);
  await page.getByRole("button", { name: "Sign in to staff dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Packing queue" })).toBeVisible();
}

async function write(page: Page, button: string) {
  const [response] = await Promise.all([
    page.waitForResponse((item) => item.request().method() === "POST" && item.url().endsWith("/api/staff/merchandising")),
    page.getByRole("button", { name: button, exact: true }).click(),
  ]);
  expect(response.ok(), response.ok() ? undefined : (await response.text()).slice(0, 250)).toBe(true);
}

async function expectPrivate(page: Page, product: string, name: string) {
  await page.goto("/products/" + product);
  await expect(page.getByRole("heading", { name: /not found/i })).toBeVisible();
  await expect(page.getByRole("heading", { name, exact: true })).toHaveCount(0);
  await expect(page.locator('script[type="application/ld+json"]')).toHaveCount(0);
}

test("owner imports, previews, approves and publishes an exact version in hosted staging", async ({ page, browser, baseURL }) => {
  test.setTimeout(200_000);
  const suffix = process.env.GRIIP_MERCHANDISING_DEMO ?? randomUUID().slice(0, 8);
  const prefix = "merch-" + suffix;
  const mugId = prefix + "-mug";
  const toteId = prefix + "-tote";
  const origin = new URL(baseURL!).origin;
  const httpCredentials = { username: process.env.STAGING_USER!, password: process.env.STAGING_PASSWORD!, origin };
  const shopper = await browser.newContext({ baseURL, httpCredentials });
  const packing = await browser.newContext({ baseURL, httpCredentials });
  const mobile = await browser.newContext({ baseURL, httpCredentials, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const name = `Staging Two-Color Tote (${suffix})`;
  const replace = (value: string) => value.replaceAll("merch-demo-", prefix + "-").replaceAll("MERCH-", `M-${suffix.toUpperCase()}-`);
  try {
    await signIn(page, "OWNER");
    const packingPage = await packing.newPage();
    await signIn(packingPage, "PACKER");
    await expect(packingPage.getByText(/ · Packer$/)).toBeVisible();
    await packingPage.goto(url);
    await expect(packingPage.getByRole("heading", { name: "Merchandising" })).toHaveCount(0);
    await expect(packingPage.getByRole("heading", { name: /not found/i })).toBeVisible();
    const denied = await packing.request.post("/api/staff/merchandising", {
      headers: { Origin: origin, "X-Griip-Merchandising": "1" }, multipart: { operation: "intake" },
    });
    expect(denied.status()).toBe(403);
    const other = await shopper.newPage();
    expect([200, 307]).toContain((await other.goto(url))?.status());
    await expect(other.getByRole("heading", { name: "Staff sign-in", exact: true })).toBeVisible();
    const uploaded = await page.request.post("/api/staff/catalog-image", {
      headers: { Origin: origin, "Content-Type": "image/webp" }, data: await readFile("public/catalog/mug-cream.webp"),
    });
    expect(uploaded.status()).toBe(201);
    const { src } = await uploaded.json();
    expect((await shopper.request.get(src)).status()).toBe(404);
    const files = await Promise.all(["catalog.csv", "evidence.json"].map((file) => readFile("tests/fixtures/merchandising/" + file, "utf8")));
    const csv = replace(files[0]).replaceAll("/catalog/mug-cream.webp", src).replaceAll("Staging Two-Color Tote", name);
    const manifest = replace(files[1]).replaceAll("/catalog/mug-cream.webp", src);
    await page.goto(url);
    const upload = async (file: string) => {
      await page.getByLabel("Supplier or source reference").fill("Synthetic supplier " + suffix);
      await page.getByLabel("Catalog CSV").setInputFiles({ name: "supplier-catalog.csv", mimeType: "text/csv", buffer: Buffer.from(file) });
      await page.getByLabel("Evidence manifest").setInputFiles({ name: "supplier-evidence.json", mimeType: "application/json", buffer: Buffer.from(manifest) });
      await write(page, "Create candidates");
      await expect(page.getByRole("list", { name: "Batch results" })).toBeVisible();
    };
    await upload(csv);
    await expect(page.getByRole("list", { name: "Batch results" })).toContainText("repeated rows 3");
    const mug = page.getByRole("link", { name: "Staging Ceramic Mug", exact: true });
    const mugPath = await mug.getAttribute("href");
    const totePath = await page.getByRole("link", { name, exact: true }).getAttribute("href");
    const usPath = await page.getByRole("link", { name: "Staging US Bottle", exact: true }).getAttribute("href");
    const missingPath = await page.getByRole("link", { name: "Staging Carry Pouch", exact: true }).getAttribute("href");
    const dualPath = await page.getByRole("link", { name: "Staging Desktop Stand", exact: true }).getAttribute("href");
    expect(mugPath && totePath && usPath && missingPath && dualPath).toBeTruthy();
    await upload(csv);
    await expect(page.getByRole("list", { name: "Batch results" })).toContainText("Staging Ceramic Mug · Unchanged");
    const readyRows = ["Staging Ceramic Mug", name, "Staging Desktop Stand"].map((product) => page.getByRole("checkbox", { name: "Select " + product, exact: true }));
    await expect(page.getByRole("checkbox", { name: "Select Staging US Bottle" })).toBeDisabled();
    await expect(page.getByRole("checkbox", { name: "Select Staging Carry Pouch" })).toBeDisabled();
    let selected = 0;
    for (const checkbox of readyRows) if (await checkbox.isEnabled()) { await checkbox.check(); selected++; }
    if (selected) {
      await write(page, "Approve selected versions");
      await expect(page.getByRole("list", { name: "Batch results" }).getByText("Approved", { exact: true })).toHaveCount(selected);
    }
    await screenshot(page, "candidate-batch");

    await page.goto(missingPath!);
    await expect(page.getByText("1 conflicting source field(s)")).toBeVisible();
    await expect(page.getByText("Supplier alternative copy for review.")).toBeVisible();
    await screenshot(page, "missing-and-conflicting");
    await page.goto(usPath!);
    await expect(page.getByRole("heading", { name: "United States · Unavailable" })).toBeVisible();
    await page.goto(dualPath!);
    await expect(page.getByText("Approved version 1 · Bangladesh")).toBeVisible();
    await expect(page.getByRole("heading", { name: "United States · Unavailable" })).toBeVisible();

    await page.goto(mugPath!);
    await expect(page.getByText(/Business verified.*FIXTURE-SAMPLE-INSPECTION/)).toBeVisible();
    await page.getByText("M-" + suffix.toUpperCase() + "-MUG-CREAM · Contribution estimate available", { exact: true }).click();
    await expect(page.getByText("Estimated contribution before ads and overhead")).toBeVisible();
    await expect(page.getByText(/1,490/)).toBeVisible();
    await screenshot(page, "pricing-worksheet");
    await page.evaluate(() => window.scrollTo(0, 0));
    await screenshot(page, "source-review");
    if (await page.getByText(/Version 1$/).count()) {
      await page.getByRole("link", { name: "Edit proposed listing" }).click();
      await page.getByLabel("Short description").fill("Ceramic mug with a rounded handle.");
      await write(page, "Save proposed edits");
      await expect(page.getByText(/Ready for review · Version 2/)).toBeVisible();
    }
    if (await page.getByRole("button", { name: "Approve this version" }).count()) await write(page, "Approve this version");
    await expect(page.getByText("Approved version 2 · Bangladesh")).toBeVisible();
    if (await page.getByRole("button", { name: "Save in catalog as draft" }).count()) await write(page, "Save in catalog as draft");
    await expect(page.getByText(/Catalog draft saved · Version 2/)).toBeVisible();
    await expectPrivate(other, mugId, "Staging Ceramic Mug");
    expect(await (await shopper.request.get("/sitemap.xml")).text()).not.toContain(mugId);
    expect((await shopper.request.get(src)).status()).toBe(404);
    await other.goto("/shop");
    await expect(other.getByText("Staging Ceramic Mug", { exact: true })).toHaveCount(0);

    await write(page, "Request listing suggestions");
    await expect(page).toHaveURL(/task=[a-f0-9]{64}/);
    const workerPath = page.url();
    const workerPanel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Merchandising worker" }) });
    await expect.poll(async () => {
      await page.reload();
      return workerPanel.getByRole("status").textContent();
    }, { timeout: 30_000 }).toContain("Model generation unavailable");
    await workerPanel.scrollIntoViewIfNeeded();
    await screenshot(page, "blocked-worker");
    await write(page, "Prepare launch draft from reviewed facts");
    await expect(page.getByText("Template draft", { exact: false })).toBeVisible();
    await page.locator("section").filter({ has: page.getByRole("heading", { name: "Launch content drafts" }) }).screenshot({
      path: evidence + "/launch-drafts.png", animations: "disabled",
    });
    await write(page, "Publish reviewed version to staging");
    await expect(page.getByText(/Published to staging · Version 2/)).toBeVisible();
    await expect(page.getByText("Refresh required", { exact: false })).toBeVisible();
    await write(page, "Prepare launch draft from reviewed facts");
    await expect(page.getByRole("link", { name: "View product", exact: true })).toHaveAttribute("href", "/products/" + mugId);
    expect((await shopper.request.get(src)).status()).toBe(200);
    await other.goto("/products/" + mugId);
    await expect(other.getByRole("heading", { name: "Staging Ceramic Mug" })).toBeVisible();
    await expect(other.getByRole("button", { name: "Out of stock" })).toBeDisabled();
    const structured = JSON.parse((await other.locator('script[type="application/ld+json"]').textContent())!);
    expect(structured.description).toBe("Ceramic mug with a rounded handle.");
    expect(structured.offers).toMatchObject({ priceCurrency: "BDT", price: "1290.00", availability: "https://schema.org/OutOfStock" });
    expect(JSON.stringify(structured)).not.toMatch(/FIXTURE-QUOTE|SUP-MUG|500 units/);

    await page.goto(totePath!);
    const preview = page.locator("#product-preview");
    await expect(preview.getByRole("heading", { name })).toHaveCount(2);
    await expect(preview.getByRole("button", { name: "Preview only" })).toBeDisabled();
    await screenshot(page, "storefront-preview-desktop", true);
    const phone = await mobile.newPage();
    await signIn(phone, "OWNER");
    await phone.goto(totePath! + "#product-preview");
    const mobilePreview = phone.locator("#product-preview");
    await mobilePreview.locator("label").filter({ hasText: /^Plum/ }).click();
    await expect(mobilePreview.getByText("৳1,590", { exact: false })).toBeVisible();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await screenshot(phone, "storefront-preview-mobile", true);
    await write(page, "Save in catalog as draft");
    await expect(page.getByText(/Catalog draft saved/)).toBeVisible();
    await expectPrivate(other, toteId, name);
    console.log(JSON.stringify({ mugPath, totePath, usPath, missingPath, dualPath, workerPath, published: mugId, draft: toteId, availability: "OutOfStock" }));
  } finally {
    await Promise.all([shopper.close(), packing.close(), mobile.close()]);
  }
});
