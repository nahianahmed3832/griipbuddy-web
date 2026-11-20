import { expect, test } from "@playwright/test";

test("shareable market selection outlives navigation, rejects forged headers and isolates preference caches", async ({ page }) => {
  const first = await page.goto("/?market=us&lang=en-BD");
  expect(first?.headers()["cache-control"]).toContain("no-store");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.locator("body")).toHaveAttribute("data-market", "us");

  const prefetched = await page.request.get("/?market=bd", { headers: { purpose: "prefetch" } });
  expect(prefetched.headers()["set-cookie"]).toBeUndefined();
  await page.setExtraHTTPHeaders({ "x-griip-current-market": "bd", "x-griip-current-language": "en-BD" });
  await page.goto("/shop");
  await expect(page.locator("body")).toHaveAttribute("data-market", "us");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");

  await page.goto("/?market=bd");
  await expect(page.locator("body")).toHaveAttribute("data-market", "bd");
  await expect(page.locator("html")).toHaveAttribute("lang", "en-BD");
  await page.goto("/shop?market=invalid");
  await expect(page.locator("body")).toHaveAttribute("data-market", "bd");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
});
