import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

const remote = process.env.GRIIPBUDDY_STAGE_URL;
const isolated = process.env.GRIIPBUDDY_ENV_FILE === ".env.test";
test.skip(!remote && !isolated, "Launch acceptance requires dedicated staging or the isolated test database.");
test.use({ trace: "off" });

const capture = async (page: Page, name: string) => {
  if (process.env.CAPTURE_STOREFRONT_SCREENSHOTS !== "1") return;
  await mkdir("docs/screenshots", { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: `docs/screenshots/launch-${name}.jpg`, fullPage: true, type: "jpeg", quality: 89 });
};

async function signIn(page: Page, role: "OWNER" | "PACKER") {
  const email = process.env[`TEST_${role}_EMAIL`];
  const password = process.env[`TEST_${role}_PASSWORD`];
  if (!email || !password) throw new Error("Configure the test staff accounts.");
  await page.goto("/staff/login");
  await page.getByLabel("Email address", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in to staff dashboard" }).click();
  await expect(page.getByRole("heading", { name: "Packing queue" })).toBeVisible();
}

test("production build journey from owner CSV through customer delivery status", async ({ page, browser, baseURL }, info) => {
  test.setTimeout(remote ? 160_000 : 85_000);
  const mobile = info.project.name === "narrow-mobile";
  const label = mobile ? "mobile" : "desktop";
  const suffix = randomUUID().slice(0, 8);
  const id = `stage-tote-${suffix}`;
  const sku = `STAGE-${suffix.toUpperCase()}-OAT`;
  const name = `Staging Test Tote ${suffix}`;
  const credentials = remote ? { username: process.env.STAGING_USER!, password: process.env.STAGING_PASSWORD!, origin: new URL(baseURL!).origin } : undefined;
  const options = { baseURL, httpCredentials: credentials, viewport: page.viewportSize() ?? undefined };
  const staffContext = await browser.newContext(options);
  const staffPage = await staffContext.newPage();
  const stranger = await browser.newContext(options);
  let orderReference: string | undefined;
  let uploaded = "";
  try {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Essentials for every day" })).toBeVisible();
    await expect(page.getByRole("contentinfo").getByText(/Staging preview/)).toBeVisible();
    await capture(page, `storefront-${label}`);

    await signIn(staffPage, "OWNER");
    const file = await readFile("public/catalog/tote-oat.webp");
    const requestHeaders = { Origin: baseURL!, "Content-Type": "image/webp" };
    expect((await stranger.request.post("/api/staff/catalog-image", { headers: requestHeaders, data: file })).status()).toBe(403);
    expect((await staffContext.request.post("/api/staff/catalog-image", { headers: requestHeaders, data: "wrong file type" })).status()).toBe(422);
    const image = await staffContext.request.post("/api/staff/catalog-image", { headers: requestHeaders, data: file });
    expect(image.status()).toBe(201);
    uploaded = (await image.json()).src;
    expect(uploaded).toMatch(/^\/media\/[a-f0-9]{64}$/);

    const csv = (await readFile("public/templates/catalog-example.csv", "utf8"))
      .replaceAll("sample-import-tote", id).replaceAll("Sample Import Tote", name)
      .replaceAll("DEMO-IMPORT-TOTE", `STAGE-${suffix.toUpperCase()}`)
      .replaceAll(",DRAFT,", ",ACTIVE,").replaceAll("/catalog/tote-oat.webp", uploaded);
    await staffPage.getByRole("link", { name: "Catalog", exact: true }).click();
    await staffPage.getByRole("link", { name: "Import CSV" }).click();
    const uploadCsv = (data: string) => staffPage.getByLabel("Catalog CSV").setInputFiles({
      name: "staging-test.csv", mimeType: "text/csv", buffer: Buffer.from(data),
    });
    await uploadCsv(csv.replace("125000,BDT,true", "125000,GBP,true"));
    await staffPage.getByRole("button", { name: "Preview import" }).click();
    await expect(staffPage.getByRole("alert").filter({ hasText: "Fix these rows" })).toContainText("Row 2 · bd_currency must be BDT");
    await expect(staffPage.getByRole("button", { name: "Apply import" })).toHaveCount(0);
    await uploadCsv(csv);
    await staffPage.getByRole("button", { name: "Preview import" }).click();
    await expect(staffPage.getByText(`New · ${name}`, { exact: true })).toBeVisible();
    await capture(staffPage, `import-${label}`);
    await staffPage.getByRole("button", { name: "Apply import" }).click();
    await expect(staffPage.getByText("1 saved · 0 unchanged · 0 failed")).toBeVisible();
    await staffPage.getByRole("button", { name: "Preview import" }).click();
    await expect(staffPage.getByText(`Unchanged · ${name}`, { exact: true })).toBeVisible();
    await staffPage.getByRole("button", { name: "Apply import" }).click();
    await expect(staffPage.getByText("0 saved · 1 unchanged · 0 failed")).toBeVisible();

    await staffPage.getByRole("link", { name: "Catalog", exact: true }).click();
    await staffPage.getByLabel("Search by product name, ID, or SKU").fill(sku);
    await staffPage.getByRole("button", { name: "Find products" }).click();
    await expect(staffPage.getByRole("link", { name, exact: true })).toHaveCount(1);
    await staffPage.getByRole("link", { name, exact: true }).click();
    await expect(staffPage.getByRole("heading", { name: `Edit ${name}` })).toBeVisible();
    await staffPage.getByLabel("Search keywords, separated by commas").fill("sample, tote, launch acceptance");
    await staffPage.getByRole("button", { name: "Save product" }).click();
    await expect(staffPage.getByRole("status").filter({ hasText: "Product saved" })).toBeVisible();
    await capture(staffPage, `product-editor-${label}`);
    await staffPage.getByRole("link", { name: "Adjust stock", exact: true }).click();
    const variant = staffPage.locator(".staff-catalog > section").filter({
      has: staffPage.getByRole("paragraph").filter({ hasText: new RegExp(` · ${sku}$`) }),
    });
    await expect(variant.getByLabel("Stock adjustment (0 available)")).toBeVisible();

    const query = page.getByRole("combobox", { name: /Search products|Search for items or shops/ });
    await query.fill(suffix);
    await query.press("Enter");
    await page.getByRole("link", { name: new RegExp(name) }).first().click();
    await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Out of stock", exact: true })).toBeDisabled();
    const photo = page.getByRole("img", { name: "Sample tote in oat", exact: true }).first();
    await expect(photo).toBeVisible();
    await expect.poll(() => photo.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    await variant.getByLabel("Stock adjustment (0 available)").fill("3");
    await variant.getByLabel("Adjustment reason").fill("Receive synthetic staging inventory");
    await variant.getByRole("button", { name: "Adjust stock" }).click();
    await expect(variant.getByLabel("Stock adjustment (3 available)")).toBeVisible();
    await page.reload();
    await page.locator("label.variant-option").filter({ has: page.getByRole("radio", { name: "Oat", exact: true }) }).click();
    await expect(page.getByRole("radio", { name: "Oat", exact: true })).toBeChecked();
    await expect(page.getByText("৳1,250", { exact: false }).first()).toBeVisible();
    await expect(page.getByRole("main").getByText("In stock", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Add to cart" }).click();
    await page.getByRole("link", { name: "View cart", exact: true }).click();
    await page.getByRole("link", { name: "Guest checkout" }).click();
    await page.getByLabel("Full name").fill(`Test Shopper ${suffix}`);
    await page.getByLabel("Phone number").fill("01700000000");
    await page.getByLabel("District").selectOption("dhaka");
    await page.getByLabel("Area / Upazila").fill("Dhanmondi");
    await page.getByLabel("Street address").fill("20 Staging Test Road");
    const beforeReview = page.waitForRequest((request) => request.url().endsWith("/api/checkout") && request.method() === "POST");
    await page.getByRole("button", { name: "Review order" }).click();
    const reviewPayload = (await beforeReview).postDataJSON();
    await expect(page.getByRole("heading", { name: "Review your order" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Order summary" }).getByText("৳1,392.50 BDT", { exact: true })).toBeVisible();
    const rejected = await page.request.post("/api/checkout", {
      headers: { Origin: baseURL! },
      data: { ...reviewPayload, checkout: { ...reviewPayload.checkout, customer: { ...reviewPayload.checkout.customer, district: "unsupported-district" } } },
    });
    expect(rejected.status()).toBe(422);
    expect((await rejected.json()).message).toContain("unavailable");
    await capture(page, `checkout-${label}`);
    const submitted = page.waitForRequest((request) => request.url().endsWith("/api/checkout") && request.method() === "POST");
    await page.getByRole("button", { name: "Place COD order" }).click();
    const submission = (await submitted).postDataJSON();
    await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
    const orderPath = new URL(page.url()).pathname;
    const duplicate = await page.request.post("/api/checkout", { headers: { Origin: baseURL! }, data: submission });
    expect(duplicate.status()).toBe(200);
    expect(orderPath).toBe(`/orders/${(await duplicate.json()).orderId}`);
    orderReference = (await page.getByText(/Order reference GB-/).textContent())!.match(/GB-[A-F0-9]{12}/)?.[0];
    expect(orderReference).toBeTruthy();
    await capture(page, `confirmation-${label}`);
    const guestPage = await stranger.newPage();
    await guestPage.goto(orderPath);
    await expect(guestPage.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await guestPage.goto("/orders");
    await expect(guestPage.getByRole("heading", { name: "No orders in this browser" })).toBeVisible();
    await guestPage.goto("/staff/catalog");
    await expect(guestPage.getByRole("heading", { name: "Staff sign-in" })).toBeVisible();

    await staffPage.reload();
    await expect(variant.getByLabel("Stock adjustment (2 available)", { exact: true })).toBeVisible();
    await staffPage.getByRole("button", { name: "Sign out", exact: true }).click();
    await expect(staffPage.getByRole("heading", { name: "Staff sign-in" })).toBeVisible();
    await signIn(staffPage, "PACKER");
    expect((await staffContext.request.post("/api/staff/catalog-import", { headers: { Origin: baseURL! }, data: csv })).status()).toBe(403);
    await staffPage.getByRole("link", { name: orderReference, exact: true }).click();
    await staffPage.getByRole("button", { name: "Mark packing" }).click();
    await staffPage.getByRole("button", { name: "Mark ready to ship" }).click();
    await staffPage.getByLabel("Carrier", { exact: true }).fill("Staging test carrier");
    await staffPage.getByLabel("Tracking reference").fill(`STAGING-${suffix.toUpperCase()}`);
    await capture(staffPage, `packing-${label}`);
    await staffPage.getByRole("button", { name: "Mark shipped" }).click();
    await expect(staffPage.getByRole("button", { name: "Mark delivered" })).toBeVisible();
    await Promise.all([
      page.waitForResponse((response) => response.request().isNavigationRequest() && new URL(response.url()).pathname === orderPath),
      page.getByRole("button", { name: "Refresh status" }).click(),
    ]);
    await expect(page.getByRole("region", { name: "Shipment information" })).toContainText(`STAGING-${suffix.toUpperCase()}`);
    await expect(page.getByRole("region", { name: "Payment and status" }).getByText("Shipped", { exact: true })).toBeVisible();
    await staffPage.getByRole("button", { name: "Mark delivered" }).click();
    await expect(staffPage.getByText("Delivered", { exact: true }).first()).toBeVisible();
    await Promise.all([
      page.waitForResponse((response) => response.request().isNavigationRequest() && new URL(response.url()).pathname === orderPath),
      page.getByRole("button", { name: "Refresh status" }).click(),
    ]);
    await expect(page.getByRole("region", { name: "Payment and status" }).getByText("Delivered", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Payment and status" }).getByText("Awaiting collection", { exact: true })).toBeVisible();
    await capture(page, `tracking-${label}`);
    await page.getByRole("link", { name: "Your recent orders" }).click();
    await expect(page.getByRole("link", { name: orderReference, exact: true })).toBeVisible();
    for (const [link, heading] of [["Delivery", "Delivery information"], ["Privacy", "Privacy"], ["Terms", "Terms"], ["Cancellations, returns and refunds", "Cancellations, returns and refunds"]]) {
      await page.getByRole("contentinfo").getByRole("link", { name: link, exact: true }).click();
      await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
      await expect(page.getByText("Draft for staging review")).toBeVisible();
    }
    console.log(`Launch journey ${label}: order ${orderReference}, product ${id}, media ${uploaded}`);
  } finally {
    await Promise.allSettled([staffContext.close(), stranger.close()]);
  }
});
