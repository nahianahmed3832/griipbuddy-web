import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

async function bagToCheckout(page: Page, market: 'bd' | 'us') {
  await page.goto('/' + market + '/product/arc-bag');
  await page.getByRole('button', { name: 'Add to bag' }).click();
  const drawer = page.getByRole('dialog', { name: 'Shopping bag' });
  await drawer.getByRole('link', { name: 'Review checkout' }).click();
  await expect(page.getByRole('heading', { name: 'Review checkout' })).toBeVisible();
}

async function address(page: Page, market: 'bd' | 'us') {
  await page.getByLabel('Recipient name').fill('Test Recipient');
  await page.getByLabel('Delivery phone').fill(market === 'bd' ? '01000000021' : '2025550117');
  await page.getByLabel('Street address').fill('123 Fixture Avenue');
  await page.getByLabel('City', { exact: true }).fill(market === 'bd' ? 'Dhaka' : 'Seattle');
  await page.getByLabel(market === 'bd' ? 'District' : 'State', { exact: true }).fill(market === 'bd' ? 'Dhaka' : 'WA');
  await page.getByLabel(market === 'bd' ? 'Postal code (optional)' : 'ZIP code').fill(market === 'bd' ? '1207' : '98101');
}

async function screenshot(page: Page, name: string) {
  const directory = process.env.GRIIPBUDDY_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(directory, name + '.png'), fullPage: false, animations: 'disabled' });
}

test('desktop signed-in journey creates, pays and finds a Stripe test order next to historical orders', async ({ page, browser }) => {
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.goto('/us/login');
  await page.getByLabel('Phone number', { exact: true }).fill('01000000021');
  await page.getByLabel('Password', { exact: true }).fill('Preview-only-2026');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/us\/account$/);
  await bagToCheckout(page, 'us');
  await address(page, 'us');
  await page.getByRole('radio', { name: /Card via Stripe/ }).check();
  await page.setViewportSize({ width: 1440, height: 1230 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await screenshot(page, 'checkout-desktop');
  await page.getByRole('button', { name: 'Place test order' }).click();
  await expect(page).toHaveURL(/\/us\/order\/[a-f\d-]+$/);
  await expect(page.getByText('Awaiting payment · Pending')).toBeVisible();
  await page.getByRole('button', { name: 'Simulate approval' }).click();
  await expect(page.getByText('Order placed · Paid')).toBeVisible();
  const orderPath = new URL(page.url()).pathname;
  const title = await page.getByRole('heading', { level: 1 }).innerText();
  await screenshot(page, 'order-desktop');
  const stranger = await browser.newPage();
  try {
    const response = await stranger.goto(page.url());
    expect(response?.status()).toBe(404);
    await expect(stranger.getByRole('heading', { name: title })).toHaveCount(0);
  } finally { await stranger.close(); }
  await page.goto('/us/account/orders');
  await expect(page.getByRole('link', { name: 'Order GB-1842', exact: true })).toBeVisible();
  await page.getByRole('link', { name: title, exact: true }).click();
  await expect(page.getByText('Order placed · Paid')).toBeVisible();
  await page.goto(orderPath);
  await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.getByText('Cancelled · Refund pending')).toBeVisible();
});

test('mobile guest COD and tablet manual checkout show correct options with no horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 1000 });
  await bagToCheckout(page, 'bd');
  await address(page, 'bd');
  await expect(page.getByRole('radio', { name: /Cash on delivery/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /Stripe|PayPal/ })).toHaveCount(0);
  await page.getByRole('radio', { name: /Advance payment/ }).check();
  await page.getByLabel('Payment phone', { exact: true }).fill('01000000021');
  await page.getByLabel('Transaction reference', { exact: true }).fill('FIXTURE-ADVANCE-01');
  await page.getByLabel(/Payment receipt/).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await screenshot(page, 'manual-mobile');
  await page.setViewportSize({ width: 768, height: 1080 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(768);
  await page.evaluate(() => window.scrollTo(0, 0));
  await screenshot(page, 'checkout-tablet');
  await page.getByRole('radio', { name: /Cash on delivery/ }).check();
  await page.getByRole('button', { name: 'Place test order' }).click();
  await expect(page.getByText('Order placed · Due on delivery')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Order placed · Due on delivery')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.getByText('Cancelled · Voided')).toBeVisible();
});

test('canonical, sitemap, noindex, redirects and security headers match the isolated release', async ({ page, request, baseURL }) => {
  await page.goto('/US/product/form-case?variant=form-case-plus');
  await expect(page).toHaveURL(/\/us\/product\/form-case\?variant=form-case-plus$/);
  await expect(page.locator('link[rel=canonical]')).toHaveAttribute('href', baseURL + '/us/product/form-case');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', baseURL + '/catalog/form-case.webp');
  await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', 'noindex, nofollow');
  const robots = await request.get('/robots.txt');
  expect(await robots.text()).toContain('Disallow: /');
  const sitemap = await request.get('/sitemap.xml');
  expect(sitemap.ok()).toBe(true);
  expect(await sitemap.text()).toContain('<loc>' + baseURL + '/bd/category/technology/phone-cases</loc>');
  expect(await sitemap.text()).not.toMatch(/\/checkout|\/account|\/order\/|\/international\/product/);
  const headers = (await request.get('/us')).headers();
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['x-frame-options']).toBe('DENY');
  expect(headers['x-powered-by']).toBeUndefined();
  expect((await request.get('/us/product/does-not-exist')).status()).toBe(404);
  expect((await request.post('/api/checkout/webhook/bkash', { data: {} })).status()).toBe(404);
});

test('representative desktop, tablet and phone pages have no serious axe findings and images load', async ({ page }) => {
  test.setTimeout(60000);
  for (const [width, route] of [[1440, '/us'], [1024, '/us/category/technology'], [390, '/us/product/form-case']] as const) {
    await page.setViewportSize({ width, height: 950 });
    await page.goto(route);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(scan.violations.map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.map((node) => node.target) }))
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical'), route).toEqual([]);
    const images = await page.locator('main img').evaluateAll((elements) => elements.filter((element) => {
      const image = element as HTMLImageElement;
      return image.getBoundingClientRect().top < window.innerHeight && image.complete && image.naturalWidth === 0;
    }).length);
    expect(images).toBe(0);
    const metrics = await page.evaluate(() => {
      const entry = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      return { ttfbMs: Math.round(entry.responseStart), domContentLoadedMs: Math.round(entry.domContentLoadedEventEnd),
        transferredKiB: Math.round(performance.getEntriesByType('resource').reduce((sum, item) =>
          sum + (item as PerformanceResourceTiming).transferSize, entry.transferSize) / 1024) };
    });
    expect(metrics.ttfbMs).toBeLessThan(1500);
    console.log(route + ' @ ' + width + 'px ' + JSON.stringify(metrics));
    if (route === '/us') await screenshot(page, 'home-desktop');
  }
  await bagToCheckout(page, 'us');
  await expect(page).toHaveTitle(/Review checkout · GriipBuddy/);
  const checkout = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(checkout.violations.map((violation) => ({ id: violation.id, impact: violation.impact, nodes: violation.nodes.map((node) => node.target) }))
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')).toEqual([]);
});

test('mobile manual receipt submission reaches review and remains unpaid', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 950 });
  await bagToCheckout(page, 'bd');
  await address(page, 'bd');
  await page.getByRole('radio', { name: /Advance payment/ }).check();
  await page.getByLabel('Payment phone', { exact: true }).fill('01000000021');
  await page.getByLabel('Transaction reference', { exact: true }).fill('MOBILE-REVIEW-001');
  const buffer = await sharp({ create: { width: 30, height: 22, channels: 3, background: 'white' } }).png().toBuffer();
  await page.getByLabel(/Payment receipt/).setInputFiles({ name: 'synthetic-receipt.png', mimeType: 'image/png', buffer });
  await page.getByRole('button', { name: /Place test order/ }).click();
  await expect(page.getByText('Awaiting receipt review · Under review')).toBeVisible();
  await expect(page.getByText('Verified payment', { exact: true })).toBeVisible();
  const id = new URL(page.url()).pathname.split('/').pop();
  expect((await page.request.get('/api/checkout/receipt?id=' + id)).status()).toBe(403);
  await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.getByText('Cancelled · Voided')).toBeVisible();
});
