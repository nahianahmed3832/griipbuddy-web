import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect as playwrightExpect } from "@playwright/test";

const expect = playwrightExpect.configure({ timeout: 14000 });

const origin = "https://dev.griipbuddy.com";
const base = "/marketplace";
const [command, run, marketId, stateFile, orderIdArg, orderItemId] = process.argv.slice(2);
const expectedRevision = process.env.GRIIP_DEV_EXPECTED_REVISION;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
assert.ok(["journey", "checkout", "return", "report", "withdraw"].includes(command) && /^[a-z0-9]{6,16}$/.test(run ?? "") &&
  ["bd", "us"].includes(marketId) && stateFile && /^[a-f0-9]{7,40}$/.test(expectedRevision ?? ""),
"Use the pinned development release, a synthetic run ID, market, and a new private browser state file.");
const health = await fetch(`${origin}${base}/api/health`, { redirect: "error", signal: AbortSignal.timeout(10000) });
assert.ok(health.ok, "Development health check failed.");
const service = await health.json();
assert.equal(service.revision, expectedRevision);
assert.deepEqual([service.database, service.visibility, service.orderIntake], ["ok", "marketplace-preview", "test-only"]);

const bd = marketId === "bd";
const otherMarket = bd ? "us" : "bd";
const path = value => base + value;
const api = value => path("/api/" + value);
const fixture = `devqa-${run}`;
const variantId = `v-${fixture}-sku`;
const fixtureName = `Development fixture tote ${run}`;
const sellerName = `Development fixture seller tote ${run}`;
const productPath = path(`/products/${fixture}`);
const orderPath = value => path(`/orders/${value}`);
const shopperRevision = process.env.GRIIP_DEV_SHOPPER_REVISION ?? "1";
assert.match(shopperRevision, /^[0-9]{1,2}$/);
const email = `${fixture}-${marketId}.${shopperRevision}@example.invalid`;
const headers = { Origin: origin };
const checkpointFile = stateFile + ".partial";
const checkpoint = command === "checkout" ? JSON.parse(await readFile(checkpointFile, "utf8")) : null;
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    baseURL: origin,
    viewport: bd ? { width: 1280, height: 850 } : { width: 320, height: 780 },
    isMobile: !bd, deviceScaleFactor: 1, hasTouch: !bd, serviceWorkers: "block",
    ...(checkpoint && { storageState: checkpoint.state }),
    ...(["return", "withdraw"].includes(command) && { storageState: JSON.parse(await readFile(stateFile, "utf8")) }),
  });
  // The browser may contact only this development slot. Disable analytics and vendor egress for this COD fixture.
  await context.route("**/*", route => {
    const target = new URL(route.request().url());
    return target.origin === origin && (target.pathname === base || target.pathname.startsWith(base + "/")) ?
      route.continue() : route.abort("blockedbyclient");
  });
  const page = await context.newPage();
  if (checkpoint) await page.addInitScript(entries => {
    for (const [key, value] of entries) if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, value);
  }, checkpoint.sessionStorage);
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(20000);
  const timings = {};
  const recentNetwork = [];
  page.on("response", response => {
    const target = new URL(response.url());
    if (target.origin !== origin || !(target.pathname.startsWith(api("measurement")) ||
        target.pathname.startsWith(api("marketplace")) || target.pathname.startsWith(api("checkout")) ||
        target.pathname === path("/search"))) return;
    const request = response.request();
    const action = request.method() === "POST" ? request.postDataJSON()?.action : null;
    recentNetwork.push([request.method(), target.pathname, action, response.status()]);
    if (recentNetwork.length > 20) recentNetwork.shift();
  });
  let phase = command;
  try {
    if (command === "report") {
      const proof = JSON.parse(await readFile(stateFile, "utf8"));
      assert.equal(proof.marketId, marketId);
      const references = proof.outcomes.map(event => event.reference);
      assert.ok(references.length === 6 && references.every(reference => /^[a-f0-9]{12}$/.test(reference)));
      const username = process.env.QA_STAFF_EMAIL;
      const password = process.env.QA_STAFF_PASSWORD;
      assert.ok(username && password, "Development staff sign-in credentials are required for the report check.");
      const staff = await context.request.post(api("staff/sign-in"), { headers, data: { email: username, password } });
      assert.equal(staff.status(), 200, "Development staff sign-in was rejected.");
      const reportUrl = path("/staff/acquisition");
      await page.goto(`${reportUrl}?market=${marketId}&scope=test&view=events`);
      await expect(page.getByRole("heading", { name: "Test records only" })).toBeVisible();
      for (const reference of references) {
        await expect(page.getByText(reference, { exact: true })).toHaveCount(1);
      }
      await page.goto(`${reportUrl}?market=${marketId}&scope=live&view=events`);
      await expect(page.getByRole("heading", { name: "Live records only" })).toBeVisible();
      for (const reference of references) {
        await expect(page.getByText(reference, { exact: true })).toHaveCount(0);
      }
      await page.goto(`${reportUrl}?market=all&scope=test`);
      const comparison = page.getByRole("region", { name: "Compare market metrics" });
      const bangladesh = comparison.getByRole("row").filter({ hasText: "Bangladesh" });
      const unitedStates = comparison.getByRole("row").filter({ hasText: "United States" });
      await expect(bangladesh).toContainText(/BDT [0-9]/);
      await expect(unitedStates).toContainText(/USD [0-9]/);
      await expect(bangladesh.getByRole("cell").last()).toHaveText("Unavailable");
      await expect(unitedStates.getByRole("cell").last()).toHaveText("Unavailable");
      await expect(page.getByText(/Consolidation requires complete merchandise evidence/)).toBeVisible();
      console.log(JSON.stringify({ marketId, inTestReport: references, excludedFromLiveReport: true, crossMarketCurrencies: ["BDT", "USD"] }));
    } else if (["return", "withdraw"].includes(command)) {
      assert.ok(uuid.test(orderIdArg ?? ""));
      const response = await page.goto(orderPath(orderIdArg));
      assert.equal(response?.status(), 200);
      await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
      if (command === "return") {
        assert.ok(uuid.test(orderItemId ?? ""));
        await expect(page.getByRole("region", { name: "Payment and status" }).getByText("Delivered", { exact: true })).toBeVisible();
        await expect(page.getByRole("region", { name: "Payment and status" }).getByText("Collected", { exact: true })).toBeVisible();
        await page.getByText("Start a request", { exact: true }).click();
        await page.getByLabel("Request type").selectOption("RETURN");
        const quantity = page.getByRole("spinbutton", { name: new RegExp(`Quantity to return for ${fixtureName}`) });
        await expect(quantity).toHaveAttribute("name", "quantity-" + orderItemId);
        await quantity.fill("1");
        await page.getByLabel("Reason for your request").fill("Development acceptance fixture return");
        const submitted = page.waitForResponse(response => new URL(response.url()).pathname === api("marketplace/cases") &&
          response.request().method() === "POST");
        await page.getByRole("button", { name: "Submit request" }).click();
        const opened = await submitted;
        assert.equal(opened.status(), 201);
        const { data: orderCase } = await opened.json();
        assert.ok(uuid.test(orderCase.id));
        await expect(page).toHaveURL(new RegExp(`/cases/${orderCase.id}$`));
        const duplicate = await context.request.post(api("marketplace/cases"), { headers, data: opened.request().postDataJSON() });
        assert.equal(duplicate.status(), 409);
        console.log(JSON.stringify({ caseId: orderCase.id, marketId, duplicateReturnRejected: true }));
      } else {
        await page.getByText("Privacy choices", { exact: true }).click();
        await page.getByRole("button", { name: "Withdraw and delete measurement" }).click();
        await expect(page.getByText("Shopping measurement is off.", { exact: true })).toBeVisible();
        const choice = await context.request.get(api("measurement"), { maxRetries: 2 });
        assert.deepEqual(await choice.json(), { choice: "off" });
        await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
        console.log(JSON.stringify({ marketId, measurementWithdrawn: true, orderStillVisible: true }));
      }
    } else {
      const observations = checkpoint?.observations ?? [];
      page.on("response", response => {
        if (response.request().method() === "POST" && new URL(response.url()).pathname === api("measurement") && response.ok()) {
          observations.push(response.request().postDataJSON());
        }
      });
      const observe = (action, predicate = () => true) => observations.find(event => event.action === action && predicate(event));
      const waitForObservation = async (action, predicate) => {
        await expect.poll(() => Boolean(observe(action, predicate)), { message: `Accepted browser ${action}` }).toBeTruthy();
        return observe(action, predicate);
      };
      const switching = async (target, name) => {
        const trigger = page.getByRole("button", { name: /Shopping preferences/ });
        const region = page.getByRole("combobox", { name: "Region" });
        await expect.poll(async () => {
          if (await region.isVisible()) return true;
          await trigger.click();
          return region.isVisible();
        }, { intervals: [200, 500, 1000] }).toBeTruthy();
        await region.selectOption(target);
        const pending = page.waitForResponse(response => new URL(response.url()).pathname === api("marketplace/region") &&
          response.request().method() === "POST");
        await page.getByRole("button", { name: "Save", exact: true }).click();
        const changed = await pending;
        assert.equal(changed.status(), 200, "Market selection endpoint must succeed");
        await expect(page.getByRole("button", { name: new RegExp(`Shopping preferences, ${name}`) })).toBeVisible();
        await expect(page.locator("header[data-market]")).toHaveAttribute("data-market", target);
        await expect(page.locator("html")).toHaveAttribute("lang", target === "bd" ? "en-BD" : "en-US");
      };
      const noOverflow = () => expect.poll(() => page.evaluate(() =>
        document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);

      let impression = checkpoint?.impression;
      let wishlistMeasured = checkpoint?.wishlistMeasured ?? false;
      if (!checkpoint) {
        phase = "region selection and catalog isolation";
        const firstNavigation = Date.now();
        const homepage = await page.goto(`${base}?market=${marketId}`);
        assert.equal(homepage?.status(), 200);
        assert.match(homepage.headers()["cache-control"], /no-store/);
        timings.homepageMs = Date.now() - firstNavigation;
        timings.homepageNavigation = await page.evaluate(() => {
          const [entry] = performance.getEntriesByType("navigation");
          return entry ? { responseStartMs: Math.round(entry.responseStart),
            domContentLoadedMs: Math.round(entry.domContentLoadedEventEnd) } : null;
        });
        await expect(page.locator("header[data-market]")).toHaveAttribute("data-market", marketId);
        await switching(otherMarket, bd ? "United States" : "Bangladesh");
        const sellerUrl = path(`/products/${fixture}-seller`);
        const switchingPage = await page.goto(sellerUrl);
        if (bd) await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
        else await expect(page.getByRole("heading", { name: sellerName })).toBeVisible();
        assert.match(switchingPage?.headers()["cache-control"] ?? "", /no-store/);
        await switching(marketId, bd ? "Bangladesh" : "United States");
        if (bd) await expect(page.getByRole("heading", { name: sellerName })).toBeVisible();
        else await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();

        phase = "consent and real visible measurement";
        await page.goto(path("/shop"));
        assert.deepEqual(await (await context.request.get(api("measurement"), { maxRetries: 2 })).json(), { choice: "off" });
        assert.deepEqual(await (await context.request.get(api("measurement"), { headers: { "Sec-GPC": "1" }, maxRetries: 2 })).json(), { choice: "blocked" });
        assert.equal(observations.length, 0);
        const privacyOptions = page.getByText("Privacy choices", { exact: true });
        for (let reload = 0; reload < 3 && !await privacyOptions.isVisible(); reload++) {
          await page.waitForTimeout(5000);
          if (!await privacyOptions.isVisible()) await page.reload();
        }
        await privacyOptions.click();
        const grant = page.waitForResponse(response => new URL(response.url()).pathname === api("measurement") &&
          response.request().method() === "POST" && response.request().postDataJSON()?.action === "allow");
        await page.getByRole("button", { name: "Allow shopping measurement" }).click();
        assert.equal((await grant).status(), 200, "Measurement consent POST must succeed.");
        await expect(page.getByText("Your choice was saved.", { exact: true })).toBeVisible();
        const listing = page.locator(`a.product-card[href^="${productPath}?"]`).first();
        await listing.scrollIntoViewIfNeeded();
        impression = await waitForObservation("PRODUCT_IMPRESSION", event => event.variantId === variantId);
        assert.equal(impression.marketId, marketId);
        assert.equal(impression.currency, bd ? "BDT" : "USD");
        assert.equal(impression.displayedPriceMinor, bd ? 112500 : 1999);
        assert.ok(uuid.test(impression.sessionId));
        for (let i = 0; i < 2; i++) {
          assert.equal((await context.request.post(api("measurement"), { headers, data: impression })).status(), 200);
        }
        const wrongMarket = await context.request.post(api("measurement"), { headers, data: { ...impression, marketId: otherMarket, displayedPriceMinor: undefined, currency: undefined } });
        assert.equal(wrongMarket.status(), 422);
        const wrongOrigin = await context.request.post(api("measurement"), { headers: { Origin: "https://example.invalid" }, data: impression });
        assert.equal(wrongOrigin.status(), 403);

        phase = "search results and product view";
        phase = "zero-result search";
        await page.goto(path("/search?q=") + encodeURIComponent(`unmatched ${run}`));
        await waitForObservation("SEARCH", event => event.resultCount === 0);
        phase = "matched search and filters";
        await page.goto(path("/search?q=") + encodeURIComponent(run));
        await expect(page.locator(`a.product-card[href^="${productPath}?"]`).first()).toBeVisible();
        await waitForObservation("SEARCH", event => event.resultCount === (bd ? 2 : 1));
        await page.getByRole("link", { name: "In stock", exact: true }).click();
        await waitForObservation("SEARCH_FILTER", event => event.filters?.availability === "in-stock");
        await page.locator(`a.product-card[href^="${productPath}?"]`).first().click();
        await expect(page).toHaveURL(new RegExp(`${productPath}(?:[?#].*)?$`));
        await expect(page.getByRole("heading", { name: fixtureName })).toBeVisible();
        await waitForObservation("PRODUCT_CLICK", event => event.variantId === variantId);
        await waitForObservation("PRODUCT_VIEW", event => event.variantId === variantId);

        phase = "shopper authentication and checkout";
        const password = randomBytes(24).toString("base64url");
        const registration = await context.request.post(api("shopper-auth/sign-up/email"), {
          headers, data: { name: "Development fixture shopper", email, password },
        });
        assert.equal(registration.status(), 200, "The isolated development shopper could not be registered.");
        const signIn = await context.request.post(api("shopper-auth/sign-in/email"), { headers, data: { email, password } });
        assert.equal(signIn.status(), 200, "The isolated development shopper could not sign in.");
        await page.reload();
        await waitForObservation("ACCOUNT_ASSOCIATED");
        if (impression.productId?.startsWith("p-")) {
          await page.getByRole("button", { name: `Add ${fixtureName} to favorites` }).click();
          await waitForObservation("WISHLIST_ADD", event => event.productId === impression.productId);
          wishlistMeasured = true;
        }
        await page.getByRole("button", { name: "Add to cart", exact: true }).click();
        await waitForObservation("CART_ADD", event => event.variantId === variantId);
        await page.goto(path("/cart"));
        await page.getByRole("link", { name: /Proceed to checkout|Guest checkout/ }).click();
        await waitForObservation("CHECKOUT_START");
        await writeFile(checkpointFile, JSON.stringify({ state: await context.storageState(),
          sessionStorage: await page.evaluate(() => Object.entries(sessionStorage)), observations, impression, wishlistMeasured }), { mode: 0o600 });
      } else {
        await page.goto(path("/checkout"));
        assert.ok(impression && uuid.test(impression.sessionId));
      }

      phase = "private checkout address and delivery";
      assert.equal(await page.evaluate(() => typeof window.clarity), "undefined");
      await expect(page.locator('body[data-clarity-mask="true"]')).toHaveCount(0);
      await expect(page.locator('dialog[aria-labelledby="mp-sign-title"][data-clarity-mask="true"]')).toHaveCount(1);
      await page.getByLabel("Full name").fill("Development fixture shopper");
      await page.getByLabel("Phone number").fill(bd ? "01700000000" : "2025550102");
      await page.getByLabel("Street address").fill("100 Development Fixture Way");
      const districts = page.locator('select[autocomplete="address-level1"]');
      assert.equal(await districts.count(), 1);
      await districts.selectOption(bd ? "dhaka" : "ny");
      await page.getByLabel(bd ? "Area or upazila" : "City", { exact: true }).fill(bd ? "Dhanmondi" : "New York");
      if (!bd) {
        await page.getByLabel("ZIP code").fill("1000");
        const zip = page.getByLabel("ZIP code");
        assert.equal(await zip.evaluate(field => field.validity.patternMismatch), true);
        await zip.fill("10001");
        await expect(page.getByRole("radio", { name: /Development express/ })).toBeVisible();
      }
      await page.getByRole("radio", { name: bd ? /Development standard/ : /Development ground/ }).check();
      await expect(page.getByRole("radio", { name: /Full cash on delivery/ })).toBeChecked();
      await noOverflow();

      phase = "backend quote and browser order";
      const quoteRequest = page.waitForRequest(request => new URL(request.url()).pathname === api("checkout") &&
        request.method() === "POST" && request.postDataJSON().action === "review");
      await page.getByRole("button", { name: "Review order" }).click();
      const quoted = await quoteRequest;
      await expect(page.getByRole("heading", { name: "Review your order" })).toBeVisible();
      const quoteResponse = await quoted.response();
      assert.equal(quoteResponse?.status(), 200);
      const quotedBody = await quoteResponse.json();
      assert.equal(quotedBody.kind, "review");
      assert.ok(uuid.test(quotedBody.attemptId));
      const quoteData = quoted.postDataJSON();
      const quoteHeaders = await quoted.allHeaders();
      const checkoutHeaders = { ...headers, "x-griipbuddy-checkout-market": quoteHeaders["x-griipbuddy-checkout-market"],
        "x-griipbuddy-measurement-session": quoteHeaders["x-griipbuddy-measurement-session"] };
      assert.equal(checkoutHeaders["x-griipbuddy-checkout-market"], marketId);
      assert.equal(checkoutHeaders["x-griipbuddy-measurement-session"], impression.sessionId);
      const disallowed = await context.request.post(api("checkout"), {
        headers: checkoutHeaders, data: { ...quoteData, checkout: { ...quoteData.checkout, deliveryMethod: bd ? "devqa-ground" : "devqa-standard" } },
      });
      assert.equal(disallowed.status(), 422);
      const wrongCurrencyMarket = await context.request.post(api("checkout"), {
        headers: { ...checkoutHeaders, "x-griipbuddy-checkout-market": otherMarket }, data: quoteData,
      });
      assert.equal(wrongCurrencyMarket.status(), 422);
      if (!bd) {
        const invalidZip = await context.request.post(api("checkout"), {
          headers: checkoutHeaders, data: { ...quoteData,
            checkout: { ...quoteData.checkout, customer: { ...quoteData.checkout.customer, postalCode: "1000" } } },
        });
        assert.equal(invalidZip.status(), 422);
        const sellerDenied = await context.request.post(api("checkout"), {
          headers: checkoutHeaders, data: { ...quoteData,
            checkout: { ...quoteData.checkout, items: [{ variantId: `v-${fixture}-seller-sku`, quantity: 1 }] } },
        });
        assert.equal(sellerDenied.status(), 422);
      }

      let accepted;
      let submitData;
      const started = Date.now();
      await page.route(`**${api("checkout")}`, async route => {
        const body = route.request().postDataJSON();
        if (body.action !== "submit") return route.continue();
        submitData = body;
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 2 });
        accepted = await response.json();
        if (bd) return route.fulfill({ response });
        return route.abort("failed");
      });
      await page.getByRole("button", { name: "Place COD order" }).click();
      if (!bd) {
        await expect(page.getByRole("alert").filter({ hasText: "couldn’t confirm" })).toBeVisible();
        assert.equal(accepted?.kind, "placed");
        await waitForObservation("CHECKOUT_FAILURE", event => event.step === "SUBMIT" && event.failureCode === "NETWORK");
        await page.reload();
        await page.getByRole("button", { name: "Check for saved order" }).click();
      }
      await expect(page.getByRole("heading", { name: "Order confirmed" })).toBeVisible();
      timings.checkoutSubmitAndRecoveryMs = Date.now() - started;
      const orderId = new URL(page.url()).pathname.split("/").at(-1);
      assert.ok(uuid.test(orderId));
      assert.deepEqual([accepted?.kind, accepted?.orderId], ["placed", orderId]);
      assert.equal(submitData?.checkout?.attemptId, quotedBody.attemptId);
      await expect(page.getByRole("region", { name: "Payment and status" }).getByText("Awaiting collection", { exact: true })).toBeVisible();
      await noOverflow();
      await waitForObservation("CHECKOUT_STEP");
      const retried = await context.request.post(api("checkout"), { headers: checkoutHeaders, data: submitData });
      assert.equal(retried.status(), 200);
      assert.equal((await retried.json()).orderId, orderId);

      phase = "private receipt and preserved test browser state";
      const unauthorized = await requestWithoutCookies(orderPath(orderId));
      assert.ok([200, 404].includes(unauthorized.status));
      assert.match(unauthorized.headers.get("cache-control") ?? "", /no-store/);
      const anonymousReceipt = await unauthorized.text();
      assert.match(anonymousReceipt, /Page not found/);
      assert.ok(!anonymousReceipt.includes("100 Development Fixture Way") && !anonymousReceipt.includes("Development fixture shopper"));
      await writeFile(stateFile, JSON.stringify(await context.storageState()), { flag: "wx", mode: 0o600 });
      console.log(JSON.stringify({ marketId, orderId, attemptId: submitData.checkout.attemptId, sessionId: impression.sessionId,
        impressionNonce: impression.nonce, shopperRevision, wishlistMeasured, timings, evidence: "fixture", mobile: !bd, checkoutReplayExcluded: true }));
    }
  } catch (error) {
    console.error(`Development commerce ${marketId}: ${phase}: ${error.message.split("\n").filter((line, i) => i === 0 || /^(Locator|Expected|Received|Error):/.test(line)).join("\n")}`);
    console.error(JSON.stringify({ recentNetwork }));
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}

function requestWithoutCookies(requestPath) {
  return fetch(origin + requestPath, { redirect: "error", signal: AbortSignal.timeout(10000) });
}
