import { readFile, mkdir } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { chromium, expect as pwExpect } from "@playwright/test";
import sharp from "sharp";

const expect = pwExpect.configure({ timeout: 24_000 });

const root = (process.env.MARKETPLACE_URL ?? "http://127.0.0.1:3116").replace(/\/$/, "");
if (!["http://127.0.0.1:3116", "http://127.0.0.1:3116/marketplace", "https://dev.griipbuddy.com/marketplace"].includes(root)) {
  throw new Error("Use the isolated local or Hostinger marketplace preview.");
}
const evidence = process.env.MARKETPLACE_EVIDENCE_DIR;
const secrets = process.env.MARKETPLACE_TEST_SECRET_DIR;
const run = (process.env.MARKETPLACE_TEST_RUN ?? randomBytes(5).toString("hex")).toLowerCase();
if (!/^[a-z0-9]{5,14}$/.test(run)) throw new Error("Use an alphanumeric test run code.");
const siteOrigin = new URL(root).origin;
const password = `Example-${randomBytes(18).toString("hex")}!`;
const browser = await chromium.launch({ executablePath: process.env.BRAVE_PATH ??
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", headless: true });
const feature = step => console.log(`PASS ${step}`);
const mail = who => `marketplace-${who}-${run}@example.invalid`;
const exact = (view, name) => view.getByRole("button", { name, exact: true });
// Server-rendered chunks can briefly include hidden copies of labelled inputs.
const field = (view, name, options) => view.getByLabel(name, options).filter({ visible: true });
const errors = [];
async function page(settings = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ...settings });
  const tab = await ctx.newPage();
  tab.setDefaultTimeout(20_000);
  tab.on("pageerror", error => errors.push(error.message));
  return tab;
}
async function open(tab, path) {
  const response = await tab.goto(root + path, { waitUntil: "load", timeout: 60_000 });
  expect(response?.status(), path).toBe(200);
  await tab.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
  return response;
}
async function shot(tab, file) {
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await tab.screenshot({ path: join(evidence, file), animations: "disabled", timeout: 25_000 });
  }
}
async function register(tab, who) {
  const dialog = tab.getByRole("dialog", { name: "Sign in", exact: true });
  await exact(tab.locator("header"), "Sign in").click();
  await exact(dialog, "Register").click();
  const form = tab.locator("dialog[open] form");
  await form.getByLabel("First name").fill(`Test ${who}`);
  await form.getByLabel("Email address").fill(mail(who));
  await form.getByLabel("Password", { exact: true }).fill(password);
  const registerResponse = tab.waitForResponse(response => response.url().endsWith("/api/shopper-auth/sign-up/email"));
  await exact(form, "Register").click();
  expect((await registerResponse).status(), `register ${who}`).toBe(200);
  await expect(tab.getByText("Use your email and password to sign in.")).toBeVisible();
  await form.getByLabel("Password", { exact: true }).fill(password);
  await exact(form, "Sign in").click();
  await expect(dialog).not.toBeVisible();
  await expect(tab.locator("header").getByRole("link", { name: "Favorites", exact: true })).toBeVisible();
}
async function staff(role) {
  const tab = await page();
  const pass = (await readFile(join(secrets, `${role}.secret`), "utf8")).trim();
  await open(tab, "/staff/login");
  const form = tab.locator("main form");
  await form.getByLabel("Email", { exact: false }).fill(`marketplace-${role}@example.invalid`);
  await form.getByLabel("Password").fill(pass);
  await exact(form, "Sign in to staff dashboard").click();
  await expect(tab.getByRole("navigation", { name: "Staff navigation" })).toBeVisible();
  return tab;
}
async function region(tab, value, label) {
  await tab.getByRole("button", { name: /Shopping preferences/ }).click();
  const dialog = tab.getByRole("dialog", { name: "Update your settings" });
  await dialog.getByLabel("Region").selectOption(value);
  await expect(dialog.getByLabel("Currency", { exact: true })).toContainText(label);
  await exact(dialog, "Save").click();
  await expect(tab.getByRole("button", { name: new RegExp(label) })).toBeVisible();
  await tab.waitForLoadState("load");
}
async function address(view, district) {
  await view.getByLabel("Full name").fill("Preview Buyer");
  await view.getByLabel("Phone number").fill("01700000000");
  await view.getByLabel(/district|delivery area/i).selectOption(district);
  await view.getByLabel("Area / Upazila").fill("Sample neighbourhood");
  await view.getByLabel("Street address").fill("Test fixture street, unit one");
  await view.getByLabel("Postal code", { exact: false }).fill("1205");
}
async function cod(tab, fee, gift, coupon) {
  await expect(tab.getByText("Test orders only", { exact: false })).toBeVisible();
  await tab.getByRole("radio", { name: /Standard delivery/ }).check();
  if (gift) {
    await tab.getByLabel("Mark order as a gift").check();
    await tab.getByLabel(/Gift message/).fill(gift);
  }
  await exact(tab, "Review order").click();
  await expect(tab.getByRole("heading", { name: "Review your order" })).toBeVisible();
  await expect(tab.getByText(new RegExp(`Standard delivery.+${fee}`))).toBeVisible();
  await expect(tab.getByText("Payment method: Cash on delivery")).toBeVisible();
  if (gift) await expect(tab.getByText(gift, { exact: false })).toBeVisible();
  if (coupon) await expect(tab.getByText(`Coupon ${coupon}`, { exact: true }).locator("..")).toContainText("65");
  await exact(tab, "Place COD order").click();
  await expect(tab).toHaveURL(/\/orders\/[0-9a-f-]{36}$/);
  return new URL(tab.url()).pathname.split("/").at(-1);
}
async function deny(tab, path, expected = 404) {
  const response = await tab.request.get(root + path, { maxRedirects: 0 });
  if (expected === 404 && response.status() === 200 && !path.startsWith("/media/")) {
    // An already streamed Next.js page reports Not Found in the response body.
    expect(await response.text(), path).toContain("Page not found");
  } else expect(response.status(), path).toBe(expected);
}
async function message(tab, button, subject, body) {
  await exact(tab, button).click();
  const dialog = tab.getByRole("dialog", { name: /Message/ });
  await dialog.getByLabel("Subject").fill(subject);
  await dialog.getByLabel("Message", { exact: true }).fill(body);
  await exact(dialog, "Send message").click();
  await expect(tab.getByRole("heading", { name: subject })).toBeVisible();
  return new URL(tab.url()).pathname.split("/").at(-1);
}

try {
  console.log(`Brave ${browser.version()} · ${root} · fixtures ${run}`);
  const buyer = await page();
  const home = await open(buyer, "/");
  expect(home.headers()["x-robots-tag"]).toMatch(/noindex/);
  await expect(buyer.locator("header").getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
  await expect(buyer.locator("footer").getByRole("button", { name: /Bangladesh.*BDT/ })).toBeVisible();
  const hero = await buyer.locator(".mp-hero").boundingBox();
  expect(Math.round(hero.width)).toBe(1208);
  await shot(buyer, "desktop-home.png");
  await buyer.locator("footer").scrollIntoViewIfNeeded();
  await shot(buyer, "desktop-footer.png");
  await region(buyer, "us", "USD");
  await region(buyer, "bd", "BDT");
  feature("Public storefront, header sign-in, footer region/currency, desktop geometry");

  const mobile = await page({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await open(mobile, "/");
  const dimensions = await mobile.evaluate(() => ({ page: document.documentElement.scrollWidth, screen: window.innerWidth }));
  expect(dimensions.screen).toBe(390);
  expect(dimensions.page).toBe(390);
  await expect(mobile.getByRole("search")).toBeVisible();
  await shot(mobile, "mobile-home.png");
  feature("390 px mobile input, layout and zero horizontal overflow");

  await register(buyer, "buyer");
  await open(buyer, "/account");
  await expect(buyer.getByRole("heading", { name: "Saved addresses" })).toBeVisible();
  const profile = buyer.locator("#profile:visible");
  await field(profile, "Display name").fill("Preview Buyer");
  await exact(profile, "Save profile").click();
  await expect(profile.getByText("Name updated.")).toBeVisible();
  const saved = buyer.locator("#addresses:visible form:visible").last();
  await saved.getByLabel("Label", { exact: true }).fill("Test address");
  await address(saved, "dhaka");
  await exact(saved, "Save address").click();
  await expect(buyer.getByText("Test address", { exact: true })).toBeVisible();
  feature("Shopper registration, sign-in, profile and private saved address");

  const search = buyer.getByRole("searchbox", { name: /Search for items or shops/ }).or(buyer.getByLabel("Search for items or shops"));
  await search.fill("iqoo");
  await expect(buyer.getByRole("list", { name: "Search suggestions" })).toBeVisible();
  await search.press("Enter");
  await expect(buyer.getByRole("heading", { name: /Results for/ })).toBeVisible();
  const filterLink = buyer.getByRole("link", { name: "In stock", exact: true });
  await filterLink.click();
  await expect(buyer).toHaveURL(/availability=in-stock/);
  await shot(buyer, "desktop-search.png");
  await buyer.locator(".product-card__image").first().click();
  await expect(buyer.getByRole("link", { name: "Buy it now" })).toBeVisible();
  const listingPath = buyer.url().slice(root.length);
  const addFavorite = buyer.getByRole("button", { name: /^Add .* to favorites$/ }).first();
  await addFavorite.click();
  await expect(buyer.getByRole("button", { name: /^Remove .* from favorites$/ }).first()).toBeVisible();
  await exact(buyer, "Zoom product image").click();
  await expect(buyer.getByRole("dialog", { name: "Product image viewer" })).toBeVisible();
  if (process.env.MARKETPLACE_LEGACY_LOCAL_BUILD === "1" && siteOrigin.startsWith("http://127.0.0.1")) await buyer.keyboard.press("Escape");
  else await exact(buyer, "Close image viewer").click();
  await expect(buyer.getByRole("dialog", { name: "Product image viewer" })).not.toBeVisible();
  await shot(buyer, "desktop-listing.png");
  await open(buyer, "/registry");
  await buyer.getByLabel("Registry name").fill(`Test registry ${run}`);
  await exact(buyer, "Create registry").click();
  await expect(buyer).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);
  const privateList = buyer.url().slice(root.length);
  await deny(mobile, privateList);
  await open(buyer, listingPath);
  await exact(buyer, "Add to collection or registry").click();
  const listDialog = buyer.getByRole("dialog", { name: "Save this item" });
  await listDialog.getByLabel("Collection or registry").selectOption({ label: `Test registry ${run} · Registry` });
  await exact(listDialog, "Save").click();
  await expect(listDialog.getByText(`Saved to Test registry ${run}.`)).toBeVisible();
  await exact(listDialog, "Close").click();
  await exact(buyer, "Add to cart").click();
  await open(buyer, "/cart");
  await expect(buyer.getByRole("heading", { name: "GriipBuddy", exact: true })).toBeVisible();
  await exact(buyer, "Save for later").click();
  await expect(buyer.getByRole("heading", { name: /Saved for later/ })).toBeVisible();
  await open(buyer, "/cart");
  await exact(buyer, "Move to cart").click();
  await buyer.getByRole("link", { name: "Proceed to checkout" }).click();
  await buyer.getByLabel("Saved addresses").selectOption({ label: "Test address" });
  await expect(buyer.getByLabel("Street address")).toHaveValue("Test fixture street, unit one");
  await shot(buyer, "desktop-checkout.png");
  const order = await cod(buyer, 70, "Synthetic gift note");
  await deny(mobile, `/orders/${order}`);
  await open(buyer, "/orders");
  await expect(buyer.locator(`main a[href$="/orders/${order}"]`)).toBeVisible();
  await open(buyer, `/orders/${order}`);
  await expect(buyer.getByText("Synthetic gift note", { exact: false })).toBeVisible();
  feature("Search, stock filter, gallery, favorites, private registry, saved cart, Dhaka BDT 70 COD and account-only receipt");

  const seller = await page();
  await open(seller, "/seller");
  await register(seller, "seller");
  const shop = `Sample shop ${run}`, slug = `sample-shop-${run}`, title = `Test acrylic desk stand ${run}`;
  await seller.getByLabel("Shop name").fill(shop);
  await seller.getByLabel("Shop address").fill(slug);
  await seller.getByLabel("About your shop").fill("Synthetic test shop for marketplace verification.");
  await exact(seller, "Create your shop").click();
  await expect(seller.getByText(/Waiting for owner review/)).toBeVisible();
  await deny(mobile, `/shops/${slug}`);
  await seller.getByRole("link", { name: "Add a listing" }).click();
  await seller.getByLabel("Listing title").fill(title);
  await seller.getByLabel("Description").fill("Synthetic desk stand for marketplace testing.");
  await seller.getByLabel("Category").selectOption({ index: 1 });
  await seller.getByLabel("Tags").fill("test stand, preview");
  await seller.getByLabel("SKU").fill("TEST-STAND");
  await seller.getByLabel("Price in BDT").fill("650");
  await seller.getByLabel("Stock quantity").fill("5");
  await seller.getByLabel("Instructions for buyers").fill("Enter the text for the desk stand.");
  await seller.getByLabel("Require personalization").check();
  await exact(seller, "Create draft listing").click();
  await expect(seller.getByRole("heading", { name: "Listing photos" })).toBeVisible();
  const draftId = new URL(seller.url()).pathname.split("/").at(-1);
  await buyer.goto(root + `/seller/listings/${draftId}`, { waitUntil: "load" });
  await expect(buyer).toHaveURL(new RegExp(`${root}/seller$`));
  await expect(buyer.getByRole("heading", { name: title })).not.toBeVisible();
  const background = `#${createHash("sha256").update(run).digest("hex").slice(0, 6)}`;
  const photo = await sharp({ create: { width: 48, height: 48, channels: 3, background } }).png().toBuffer();
  await seller.getByLabel("Listing photo").setInputFiles({ name: "fixture.png", mimeType: "image/png", buffer: photo });
  await seller.getByLabel("Photo description").fill("Preview desk stand");
  await exact(seller, "Upload photo").click();
  const media = seller.getByRole("img", { name: "Preview desk stand" });
  await expect(media).toBeVisible();
  const mediaPath = (await media.getAttribute("src")).split("/media/").at(-1);
  await deny(mobile, `/media/${mediaPath}`);
  feature("Private seller onboarding, draft creation, scoped photo upload, unpublished media access");

  if (secrets) {
    const owner = await staff("owner");
    const packer = await staff("packer");
    await deny(packer, "/staff/marketplace");
    await open(owner, "/staff/marketplace");
    const shopCard = owner.getByRole("listitem").filter({ has: owner.getByText(`${shop} · Private`) });
    await exact(shopCard, "Approve shop").click();
    await expect(owner.getByText(`${shop} · Public`)).toBeVisible();
    await owner.getByRole("link", { name: `${title} · DRAFT` }).click();
    await owner.getByLabel("Publication").selectOption("ACTIVE");
    await exact(owner, "Save product").click();
    await expect(owner.getByText("Product saved.", { exact: true })).toBeVisible();
    await open(buyer, `/shops/${slug}`);
    await exact(buyer, "Follow shop").click();
    await expect(exact(buyer, "Following shop")).toBeVisible();
    await expect(buyer.locator(".product-card").filter({ has: buyer.getByRole("heading", { name: title, exact: true }) })).toBeVisible();
    const thread = await message(buyer, "Message shop", `Listing question ${run}`, "Does the fixture come in another color?");
    await deny(mobile, `/messages/${thread}`);
    await open(seller, `/messages/${thread}`);
    await seller.getByLabel("Reply").fill("This synthetic fixture comes in one color.");
    await exact(seller, "Send reply").click();
    await expect(seller.getByText("This synthetic fixture comes in one color.")).toBeVisible();
    await open(buyer, `/messages/${thread}`);
    await expect(buyer.getByText("This synthetic fixture comes in one color.")).toBeVisible();
    await open(packer, `/staff/orders/${order}`);
    await exact(packer, "Mark packing").click();
    await exact(packer, "Mark ready to ship").click();
    await packer.getByLabel("Carrier", { exact: true }).fill("Synthetic carrier");
    await packer.getByLabel("Tracking reference").fill(`TEST-${run}`);
    await exact(packer, "Mark shipped").click();
    await exact(packer, "Mark delivered").click();
    await expect(packer.getByText("Delivered", { exact: true }).first()).toBeVisible();
    await open(owner, `/staff/orders/${order}`);
    await owner.getByLabel("I confirm the full amount was received.").check();
    await exact(owner, "Record collection").click();
    await expect(owner.getByText("Collected", { exact: true }).first()).toBeVisible();
    await open(buyer, `/orders/${order}`);
    await buyer.locator("summary").filter({ hasText: /^Review / }).first().click();
    await buyer.getByLabel("Your review").fill(`Verified synthetic review ${run}.`);
    await exact(buyer, "Submit review").click();
    await expect(buyer.getByText("Your review is waiting for moderation.")).toBeVisible();
    await open(owner, "/staff/marketplace");
    const review = owner.getByText(`Verified synthetic review ${run}.`, { exact: true }).locator("..");
    await exact(review, "Restore review").click();
    await expect(exact(review, "Hide review")).toBeVisible();
    await open(buyer, listingPath);
    await expect(buyer.getByText(`Verified synthetic review ${run}.`, { exact: true })).toBeVisible();
    await open(buyer, `/orders/${order}`);
    const support = await message(buyer, "Get help from GriipBuddy", `Order help ${run}`, "Synthetic follow-up about my COD order.");
    await open(owner, `/messages/${support}`);
    await owner.getByLabel("Reply").fill("Synthetic owner response.");
    await exact(owner, "Send reply").click();
    await expect(owner.getByText("Synthetic owner response.")).toBeVisible();
    feature("Owner approvals, public shop and listing, follow, seller messages, packer delivery, owner COD collection, verified review and order support");

    await open(buyer, `/orders/${order}`);
    await buyer.getByText("Request a return or open a dispute", { exact: true }).click();
    await field(buyer, "Case type").selectOption("RETURN");
    await field(buyer, "What happened?").fill("The test item needs a return. This is a rehearsal.");
    await exact(buyer, "Submit case").click();
    await expect(buyer).toHaveURL(/\/orders\/[0-9a-f-]{36}\/cases\/[0-9a-f-]{36}$/);
    const casePath = buyer.url().slice(root.length);
    const caseId = casePath.split("/").at(-1);
    await deny(mobile, casePath);
    await deny(packer, `/staff/cases/${caseId}`);
    await open(owner, `/staff/cases/${caseId}`);
    for (const [status, note] of [
      ["IN_REVIEW", "We have reviewed the rehearsal request."],
      ["RETURN_APPROVED", "Return approved for this rehearsal."],
      ["RESOLVED", "The test return is closed."],
    ]) {
      await field(owner, "New status").selectOption(status);
      await field(owner, "Message to shopper").fill(note);
      await exact(owner, "Save case update").click();
      await expect(owner.getByText(note, { exact: true })).toBeVisible();
    }
    await open(buyer, casePath);
    await expect(buyer.getByText("The test return is closed.", { exact: true })).toBeVisible();
    feature("Buyer return request, staff-only case updates and shopper case history");

    await open(owner, "/staff/coupons");
    const coupon = `QA-${run.toUpperCase()}`;
    await field(owner, "Code", { exact: true }).fill(coupon);
    await owner.getByRole("combobox", { name: "Shop", exact: true }).selectOption({ label: shop });
    await field(owner, "Discount value").fill("10");
    await field(owner, "Order limit (optional)").fill("1");
    await exact(owner, "Create coupon").click();
    await expect(owner.getByText(coupon, { exact: true })).toBeVisible();

    await open(mobile, `/shops/${slug}`);
    await mobile.locator(".product-card").filter({ has: mobile.getByRole("heading", { name: title, exact: true }) }).click();
    await expect(exact(mobile, "Buy it now")).toBeDisabled();
    await field(mobile, "Personalization", { exact: true }).fill("QA Desk");
    await exact(mobile, "Buy it now").click();
    await mobile.waitForURL(url => url.pathname.endsWith("/checkout") && url.searchParams.has("custom"));
    await expect(field(mobile, "Personalization", { exact: true })).toHaveValue("QA Desk");
    expect(mobile.url()).not.toContain("QA%20Desk");
    await address(mobile.locator("main form"), "outside-dhaka");
    await mobile.getByLabel("Email (optional)").fill(mail("guest"));
    await field(mobile, "Coupon code (optional)").fill(coupon.toLowerCase());
    const guest = await cod(mobile, 100, undefined, coupon);
    await expect(mobile.getByText("QA Desk", { exact: false })).toBeVisible();
    await expect(mobile.getByText(`Coupon ${coupon}`, { exact: true })).toBeVisible();
    await deny(buyer, `/orders/${guest}`);
    await register(mobile, "guest");
    await exact(mobile, "Save order to your account").click();
    await expect(mobile.getByText("Order saved to your purchases.")).toBeVisible();
    await open(seller, "/seller/orders");
    await expect(seller.getByText(title, { exact: false })).toBeVisible();
    await expect(seller.getByText("QA Desk", { exact: false })).toBeVisible();
    for (const action of ["Start preparing", "Mark ready for pickup", "Confirm handoff"]) await exact(seller, action).click();
    await expect(seller.getByText("Shop preparation: Handed to GriipBuddy")).toBeVisible();
    const exportHref = await seller.getByRole("link", { name: "Download CSV" }).getAttribute("href");
    const csv = await seller.request.get(siteOrigin + exportHref);
    expect(csv.status()).toBe(200);
    expect(await csv.text()).toContain(title);
    await open(packer, `/staff/orders/${guest}`);
    await expect(packer.getByText("Handed to GriipBuddy", { exact: false })).toBeVisible();
    feature("Personalized mobile Buy it now, shop coupon, outside Dhaka COD, seller CSV and warehouse handoff");

    const variantId = new URL(root + listingPath).searchParams.get("variant");
    expect(variantId).toMatch(/^v-/);
    const details = { marketId: "bd", items: [{ variantId, quantity: 1 }], deliveryMethod: "standard", paymentMethod: "COD",
      customer: { name: "Test intake probe", phone: "01700000000", district: "dhaka",
        locality: "Sample neighbourhood", address: "Test fixture street, unit one" } };
    const checkout = data => buyer.request.post(root + "/api/checkout", { headers: { Origin: siteOrigin }, data });
    const quoteResponse = await checkout({ action: "review", checkout: details });
    expect(quoteResponse.status()).toBe(200);
    const quote = await quoteResponse.json();
    expect(quote.kind).toBe("review");
    await open(owner, "/staff/settings");
    try {
      await exact(owner, "Pause new orders").click();
      await expect(owner.getByText("Checkout is closed.", { exact: true })).toBeVisible();
      const blocked = await checkout({ action: "submit", checkout: { ...details, attemptId: quote.attemptId, reviewToken: quote.quote.reviewToken } });
      expect(blocked.status()).toBe(422);
      expect((await blocked.json()).kind).toBe("unavailable");
      const unavailable = await checkout({ action: "review", checkout: details });
      expect(unavailable.status()).toBe(422);
      await open(buyer, `/orders/${order}`);
      const abandoned = await checkout({ action: "recover", attemptId: quote.attemptId });
      expect((await abandoned.json()).kind).toBe("abandoned");
    } finally {
      await open(owner, "/staff/settings");
      const openCheck = owner.getByLabel("Enable checkout", { exact: true });
      if (!await openCheck.isChecked()) {
        await openCheck.check();
        await exact(owner, "Save market settings").click();
        await expect(owner.getByText("Test COD checkout is open.", { exact: true })).toBeVisible();
      }
    }
    feature("Server enforced intake pause for new reviews and an already quoted submission; accepted order remains accessible; test intake restored");
  }
  const foreignOrigin = await buyer.request.post(root + "/api/marketplace/region", {
    headers: { Origin: "https://example.invalid" }, data: { region: "us" },
  });
  expect(foreignOrigin.status()).toBe(403);
  const unauthorized = await mobile.request.post(root + "/api/marketplace", {
    headers: { Origin: siteOrigin }, data: { action: "staff-shop", shop: "00000000-0000-4000-8000-000000000001", published: false },
  });
  expect([401, 403]).toContain(unauthorized.status());
  expect(errors).toEqual([]);
  feature("Session and role boundaries; no browser runtime errors");
} catch (error) {
  console.error(String(error).slice(0, 2500));
  process.exitCode = 1;
} finally {
  await browser.close();
}
