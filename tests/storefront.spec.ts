import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { decodeCart, marketCartStorageKey } from "../src/lib/cart/model";

const tote = "/products/canvas-carryall-tote";
const saveScreenshots = process.env.CAPTURE_STOREFRONT_SCREENSHOTS === "1";

function shoppingPreferences(page: Page) {
  return page.getByRole("contentinfo").getByRole("button", { name: /^Shopping preferences,/ });
}

async function selectMarket(page: Page, market: "bd" | "us") {
  await shoppingPreferences(page).click();
  const dialog = page.getByRole("dialog", { name: "Shopping preferences" });
  await dialog.getByRole("combobox", { name: "Region" }).selectOption(market);
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).toBeHidden();
}

async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
}

async function screenshot(page: Page, name: string, fullPage = true) {
  if (!saveScreenshots) return;
  await mkdir("docs/screenshots", { recursive: true });
  await page.evaluate(async () => {
    await document.fonts.ready;
    for (const image of document.images) image.loading = "eager";
  });
  await expect.poll(() => page.locator("main img:visible").evaluateAll((images) => images
    .map((node) => node as HTMLImageElement)
    .filter((image) => !image.complete || image.naturalWidth === 0)
    .map((image) => image.currentSrc || image.src))).toEqual([]);
  await page.screenshot({ path: `docs/screenshots/${name}.jpg`, type: "jpeg", quality: 88, fullPage, animations: "disabled" });
}

test("home, departments, collections, sorting, filters and search", async ({ page }, info) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Essentials for every day");
  await expect(page.getByRole("contentinfo").getByText("Staging preview · Sample products and test orders")).toBeVisible();
  await noOverflow(page);
  if (saveScreenshots && info.project.name === "narrow-mobile") {
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, "home-mobile");
    await page.setViewportSize({ width: 320, height: 780 });
  } else {
    await screenshot(page, "home-desktop");
  }

  if (info.project.name === "desktop") {
    const discoveryLinks = await page.locator('main a[href^="/departments/"], main a[href^="/collections/"]').evaluateAll(
      (links) => [...new Set(links.map((link) => (link as HTMLAnchorElement).href))],
    );
    expect(new Set(discoveryLinks.map((href) => new URL(href).pathname)).size).toBe(11);
    for (const href of discoveryLinks) expect((await page.request.get(href)).status(), href).toBe(200);
  }
  await page.getByRole("link", { name: "Shop Everyday Carry" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Everyday Carry" })).toBeVisible();
  await page.getByRole("link", { name: /Canvas Carryall Tote/ }).click();
  await expect(page.getByRole("heading", { name: "Canvas Carryall Tote", level: 1 })).toBeVisible();
  await page.getByRole("navigation", { name: "Departments", exact: true }).getByRole("link", { name: "Home & Living", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Home & Living" })).toBeVisible();
  await expect(page.locator(".listing-results:visible")).toContainText("4 products");
  await page.getByRole("combobox", { name: "Sort by", exact: true }).selectOption("price-low");
  await page.getByRole("button", { name: "Apply sort", exact: true }).click();
  await expect(page.getByRole("heading", { level: 3 }).first()).toHaveText("Amber Ripple Glass");
  if (info.project.name === "desktop") await screenshot(page, "department-desktop");
  const filterTrigger = page.getByRole("button", { name: "Filters", exact: true });
  const mobileFilters = await filterTrigger.isVisible();
  if (mobileFilters) await filterTrigger.click();
  const filters = page.getByRole(mobileFilters ? "dialog" : "complementary", { name: "Filters", exact: true });
  await filters.getByRole("checkbox", { name: "Lilac", exact: true }).check();
  await filters.getByRole("group", { name: "Availability" }).getByRole("checkbox", { name: "In stock", exact: true }).check();
  await filters.getByRole("button", { name: "Apply filters", exact: true }).click();
  await expect(page.getByRole("heading", { name: "No products match these filters" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Sort by", exact: true })).toHaveValue("price-low");
  await page.getByRole("link", { name: "Clear filters", exact: true }).last().click();
  await expect(page.locator(".listing-results:visible")).toContainText("4 products");
  await noOverflow(page);

  const search = page.getByRole("combobox", { name: "Search products" });
  await search.fill("wireless");
  await search.press("Enter");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Results for “wireless”");
  await expect(page.getByRole("heading", { name: "Studio Wireless Headphones", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pocket Bluetooth Speaker", exact: true })).toBeVisible();
  await search.fill("Home & Living");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Amber Ripple Glass" })).toBeVisible();
  await search.fill("no-such-demo-product");
  await search.press("Enter");
  await expect(page.getByRole("heading", { name: "No products found" })).toBeVisible();
  await page.getByRole("link", { name: "Start a new search" }).click();
  await expect(page.getByRole("heading", { name: "What are you looking for?" })).toBeVisible();
  await noOverflow(page);
});

test("variant selection, gallery, cart persistence and market switch", async ({ page }, info) => {
  await page.goto(tote);
  await expect(page.getByRole("heading", { level: 1, name: "Canvas Carryall Tote" })).toBeVisible();
  await expect(page.getByText("৳1,250", { exact: false }).first()).toBeVisible();
  await page.getByRole("button", { name: /View image .*stitching/ }).click();
  await expect(page.getByRole("img", { name: "Detail of the stitching on the plum canvas tote handle" })).toBeVisible();
  if (info.project.name === "desktop") {
    const plum = page.getByRole("radio", { name: "Plum", exact: true });
    await plum.focus();
    await plum.press("ArrowRight");
  } else {
    await page.locator("label.variant-option").filter({ has: page.getByRole("radio", { name: "Oat", exact: true }) }).click();
  }
  await expect(page.getByRole("radio", { name: "Oat", exact: true })).toBeChecked();
  await expect(page.getByText("৳1,150", { exact: false })).toBeVisible();
  await expect(page.getByRole("img", { name: "Oat canvas carryall tote with stitched handles" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("radio", { name: "Plum", exact: true })).toBeChecked();
  await page.goForward();
  await expect(page.getByRole("radio", { name: "Oat", exact: true })).toBeChecked();
  await noOverflow(page);
  if (info.project.name === "narrow-mobile") await screenshot(page, "product-narrow-mobile");

  await page.getByRole("button", { name: "Increase quantity" }).click();
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByRole("link", { name: "Cart, 2 items" })).toBeVisible();
  await expect.poll(async () => decodeCart(await page.evaluate(key => localStorage.getItem(key), marketCartStorageKey("bd"))))
    .toEqual([{ variantId: "v-tote-oat", quantity: 2 }]);
  await page.getByRole("link", { name: "View cart", exact: true }).click();
  const summary = page.getByRole("complementary", { name: "Cart summary" });
  await expect(summary.getByText("৳2,300", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Increase quantity" }).click();
  await expect(summary.getByText("৳3,450", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Decrease quantity" }).click();
  await expect(summary.getByText("৳2,300", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Increase quantity" }).click();
  await page.reload();
  await expect(summary.getByText("৳3,450", { exact: true })).toBeVisible();
  await expect(summary.getByText("Not calculated", { exact: true })).toHaveCount(2);
  await expect(summary.getByRole("link", { name: "Guest checkout" })).toBeVisible();

  await page.getByRole("link", { name: "Canvas Carryall Tote", exact: true }).click();
  await selectMarket(page, "us");
  await expect(page).toHaveURL(url => url.searchParams.get("variant") === "v-tote-oat" && url.searchParams.get("market") === "us");
  await expect(page.getByRole("status").filter({ hasText: "This variant is unavailable in United States." })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Oat", exact: true })).toHaveCount(0);
  await expect(page.getByRole("main").locator(".product-detail__price:visible")).toHaveCount(0);
  const cartLink = page.getByRole("link", { name: "Cart, 0 items" });
  await cartLink.click();
  const drawer = page.getByRole("dialog", { name: "Your cart" });
  await expect(drawer.getByText("Your cart is empty.", { exact: true })).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Close cart" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(cartLink).toBeFocused();
  await cartLink.click();
  await drawer.getByRole("link", { name: "View full cart" }).click();
  await expect(page.getByText("Shopping in United States · USD")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your cart is empty" })).toBeVisible();
  await expect(cartLink).toBeVisible();
  await page.goto(tote);
  await expect(page.getByRole("main").locator(".product-detail__price:visible")).toHaveText("$18.00 USD");
  await page.getByRole("button", { name: "Add to cart" }).click();
  await page.getByRole("link", { name: "View cart", exact: true }).click();
  await expect(summary.getByText("$18.00", { exact: true })).toBeVisible();
  await expect(summary.getByRole("button", { name: "Checkout unavailable" })).toBeDisabled();
  await noOverflow(page);
  if (info.project.name === "desktop") await screenshot(page, "cart-market-desktop");

  await selectMarket(page, "bd");
  await expect(summary.getByText("৳3,450", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove Canvas Carryall Tote — Oat" }).click();
  await expect(page.getByRole("heading", { name: "Your cart is empty" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Cart, 0 items" })).toBeVisible();
  await selectMarket(page, "us");
  await expect(summary.getByText("$18.00", { exact: true })).toBeVisible();
});

test("stock states, market-specific products and missing routes", async ({ page }) => {
  await page.goto("/products/morning-stoneware-mug");
  await page.locator("label.variant-option").filter({ has: page.getByRole("radio", { name: /^Lilac/ }) }).click();
  await expect(page.getByRole("button", { name: "Out of stock", exact: true })).toBeDisabled();
  await expect(page.getByRole("img", { name: "Speckled lilac ceramic mug with a rounded handle" })).toBeVisible();
  await selectMarket(page, "us");
  await expect(page.getByRole("radio", { name: /^Lilac.*out of stock/ })).toBeChecked();
  await expect(page.getByRole("main").locator(".product-detail__price:visible")).toHaveText("$15.50 USD");
  await expect(page.getByRole("button", { name: "Out of stock", exact: true })).toBeDisabled();
  await page.reload();
  await expect(shoppingPreferences(page)).toHaveAccessibleName("Shopping preferences, United States, USD");
  await page.goto("/departments/home-living");
  await expect(page.getByRole("heading", { name: "Dome Table Lamp" })).toHaveCount(0);
  await page.goto("/products/dome-table-lamp");
  await expect(page.getByRole("heading", { level: 1, name: "Product unavailable" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Browse products", exact: true })).toHaveAttribute("href", /market=us/);
  await page.goto("/products/does-not-exist");
  await expect(page.getByRole("heading", { level: 1, name: "Product unavailable" })).toBeVisible();
});

test("footer preferences save explicitly and header offers demo sign-in", async ({ page }, info) => {
  await page.goto("/");
  const header = page.getByRole("banner");
  const signIn = header.getByRole("button", { name: "Sign in", exact: true });
  const account = header.getByRole("button", { name: "Demo account", exact: true });
  const footerSettings = shoppingPreferences(page);

  await expect(header.getByRole("button", { name: /^Shopping preferences,/ })).toHaveCount(0);
  await expect(footerSettings).toHaveAccessibleName("Shopping preferences, Bangladesh, BDT");
  await footerSettings.press("Enter");
  const settings = page.getByRole("dialog", { name: "Shopping preferences" });
  const region = settings.getByRole("combobox", { name: "Region" });
  await expect(region).toBeFocused();
  await region.selectOption("us");
  await expect(settings.getByText("US Dollar (USD)", { exact: true })).toBeVisible();
  if (info.project.name === "desktop") await screenshot(page, "shopping-preferences-desktop", false);
  await settings.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(footerSettings).toBeFocused();
  await expect(footerSettings).toHaveAccessibleName("Shopping preferences, Bangladesh, BDT");

  await selectMarket(page, "us");
  await expect(footerSettings).toHaveAccessibleName("Shopping preferences, United States, USD");
  await page.getByRole("navigation", { name: "Footer collections" }).getByRole("link", { name: "New arrivals", exact: true }).click();
  const toteCard = page.getByRole("region", { name: "Products", exact: true }).getByRole("link", { name: /Canvas Carryall Tote/ });
  await expect(toteCard.getByText("$18.00", { exact: true })).toBeVisible();
  await page.goto("/");
  await page.evaluate(() => window.scrollTo(0, 0));

  await signIn.press("Enter");
  const signInDialog = page.getByRole("dialog", { name: "Sign in", exact: true });
  await expect(signInDialog.getByRole("textbox", { name: "Demo email address" })).toHaveValue("shopper@example.com");
  await expect(signInDialog.getByRole("textbox", { name: "Demo email address" })).toHaveAttribute("readonly", "");
  if (info.project.name === "desktop") await screenshot(page, "sign-in-desktop", false);
  await signInDialog.getByRole("button", { name: "Continue as guest" }).click();
  await expect(signInDialog).toBeHidden();
  await expect(signIn).toBeFocused();

  await signIn.click();
  await signInDialog.getByRole("button", { name: "Sign in with demo account" }).click();
  await expect(account).toBeVisible();
  await page.reload();
  await expect(account).toBeVisible();
  await expect(footerSettings).toHaveAccessibleName("Shopping preferences, United States, USD");
  await account.click();
  await page.getByRole("dialog", { name: "Demo account", exact: true }).getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(signIn).toBeVisible();
  await expect(footerSettings).toHaveAccessibleName("Shopping preferences, United States, USD");
  await noOverflow(page);
});

test("cart reports loading and can recover from a catalog lookup error", async ({ page }) => {
  await page.goto(tote);
  let release = () => {};
  const hold = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/cart/resolve", async (route) => {
    await hold;
    await route.fulfill({ status: 503, json: { message: "Test outage" } });
  });
  try {
    await page.getByRole("button", { name: "Add to cart" }).click();
    await page.getByRole("link", { name: "View cart", exact: true }).click();
    await expect(page.getByText("Checking prices and availability for Bangladesh…")).toBeVisible();
  } finally {
    release();
  }
  await expect(page.getByRole("heading", { name: "We couldn’t load your cart details" })).toBeVisible();
  await page.unroute("**/api/cart/resolve");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("complementary", { name: "Cart summary" }).getByText("৳1,250", { exact: true })).toBeVisible();
});

test("keyboard landmarks, image alternatives and accessibility", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  const categoryMenu = page.locator("summary", { hasText: "Categories" });
  await categoryMenu.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("navigation", { name: "Browse categories" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("navigation", { name: "Browse categories" }).getByRole("link", { name: "Shop all", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("navigation", { name: "Browse categories" })).toBeHidden();
  await expect(categoryMenu).toBeFocused();
  expect(await page.locator("main img").evaluateAll(images => images.every(image => {
    const alt = image.getAttribute("alt");
    if (image.closest('nav[aria-label="Category shortcuts"], nav[data-home-tile-layout="shortcuts"]')) {
      return alt === "" && Boolean(image.closest("a")?.textContent?.trim());
    }
    return Boolean(alt?.trim());
  }))).toBe(true);
  if (info.project.name === "desktop") {
    const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
    expect(results.violations.map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target }) => target) }))).toEqual([]);
  }
  expect(errors).toEqual([]);
});
