import { expect, test } from "@playwright/test";

test("public replay is deferred, tagged and isolated from private pages", async ({ page }) => {
  const project = process.env.CLARITY_PROJECT_ID;
  test.skip(!project || !process.env.GRIIPBUDDY_ENV_FILE, "Requires local replay configuration.");

  let loads = 0;
  await page.route(`https://www.clarity.ms/tag/${project}`, async route => {
    loads++;
    await route.fulfill({ contentType: "application/javascript", body: `
      const queued = window.clarity.q;
      window.clarity = (method, ...args) => {
        if (method === "metadata") args[0]();
        else {
          const log = JSON.parse(sessionStorage.getItem("clarity-test-log") || "[]");
          log.push([method, ...args]);
          sessionStorage.setItem("clarity-test-log", JSON.stringify(log));
        }
      };
      for (const args of queued) window.clarity(...args);
      sessionStorage.setItem("clarity-test-loaded-after", document.readyState);
    ` });
  });

  const log = () => page.evaluate(() => JSON.parse(sessionStorage.getItem("clarity-test-log") || "[]"));
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByText("Privacy choices", { exact: true }).click();
  await page.getByRole("button", { name: "Allow shopping measurement" }).click();
  await expect(page.getByRole("button", { name: "Allow session replay" })).toBeVisible();
  expect(loads).toBe(0);
  await page.getByRole("button", { name: "Allow session replay" }).click();
  await expect.poll(log).toEqual(expect.arrayContaining([
    ["consentv2", { ad_Storage: "denied", analytics_Storage: "granted" }],
    ["set", "market", "bd"],
    ["set", "page_type", "home"],
  ]));
  expect(loads).toBe(1);
  expect(await page.evaluate(() => sessionStorage.getItem("clarity-test-loaded-after"))).toBe("complete");
  await expect(page.locator("body")).toHaveAttribute("data-clarity-mask", "true");

  await page.locator("footer").getByRole("link", { name: "Your cart", exact: true }).click();
  await expect(page).toHaveURL(/\/cart$/);
  await expect.poll(() => page.evaluate(() => "clarity" in window)).toBe(false);
  expect(loads).toBe(1);

  await page.goto("/?email=fixture%40example.test");
  await page.getByText("Privacy choices", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Turn off session replay" })).toBeVisible();
  expect(await page.evaluate(() => "clarity" in window)).toBe(false);
  expect(loads).toBe(1);

  await page.goto("/");
  await expect.poll(() => loads).toBe(2);
  await page.getByText("Privacy choices", { exact: true }).click();
  await page.getByRole("button", { name: "Turn off session replay" }).click();
  await expect.poll(log).toContainEqual(["consentv2", { ad_Storage: "denied", analytics_Storage: "denied" }]);
  await expect.poll(() => page.evaluate(() => "clarity" in window)).toBe(false);
  expect(loads).toBe(2);
  await page.getByText("Privacy choices", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Allow session replay" })).toBeVisible();
  await page.getByRole("button", { name: "Allow session replay" }).click();
  await expect.poll(() => loads).toBe(3);
  await page.getByRole("button", { name: "Withdraw and delete measurement" }).click();
  await expect.poll(() => page.evaluate(() => "clarity" in window)).toBe(false);
  await page.getByText("Privacy choices", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Allow shopping measurement" })).toBeVisible();
});

test("a stalled replay tag leaves the mobile shopping flow usable", async ({ page }, testInfo) => {
  const project = process.env.CLARITY_PROJECT_ID;
  test.skip(testInfo.project.name !== "narrow-mobile" || !project || !process.env.GRIIPBUDDY_ENV_FILE,
    "Requires narrow-mobile and a local replay configuration.");
  let observed = false;
  let releaseTag!: () => void;
  const tagBlocked = new Promise<void>(resolve => { releaseTag = resolve; });
  await page.route(`https://www.clarity.ms/tag/${project}`, async route => {
    observed = true;
    await tagBlocked;
    await route.abort().catch(() => {});
  });
  try {
    await page.goto("/");
    await page.getByText("Privacy choices", { exact: true }).click();
    await page.getByRole("button", { name: "Allow shopping measurement" }).click();
    await page.getByRole("button", { name: "Allow session replay" }).click();
    await expect.poll(() => observed).toBe(true);
    await page.locator("footer").getByRole("link", { name: "Your cart", exact: true }).click();
    await expect(page).toHaveURL(/\/cart$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  } finally {
    releaseTag();
  }
});

test("each market requires an independent replay opt-in", async ({ page }, testInfo) => {
  const defaultProject = process.env.CLARITY_PROJECT_ID;
  const bdProject = process.env.CLARITY_PROJECT_ID_BD ?? defaultProject;
  const usProject = process.env.CLARITY_PROJECT_ID_US ?? defaultProject;
  test.skip(testInfo.project.name !== "desktop" || !bdProject || !usProject || !process.env.GRIIPBUDDY_ENV_FILE,
    "Requires two configured local replay markets.");
  let loads = 0;
  await page.route("https://www.clarity.ms/tag/*", route => {
    loads++;
    return route.fulfill({ contentType: "application/javascript", body: "window.clarity = () => {}" });
  });
  await page.goto("/?market=bd");
  await page.getByText("Privacy choices", { exact: true }).click();
  await page.getByRole("button", { name: "Allow shopping measurement" }).click();
  await page.getByRole("button", { name: "Allow session replay" }).click();
  await expect.poll(() => loads).toBe(1);
  await page.goto("/?market=us");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await page.getByText("Privacy choices", { exact: true }).click();
  const allow = page.getByRole("button", { name: "Allow session replay" });
  await expect(allow).toBeVisible();
  expect(await page.evaluate(() => "clarity" in window)).toBe(false);
  await allow.click();
  await expect.poll(() => loads).toBe(2);
});
