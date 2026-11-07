import { expect, test } from '@playwright/test';
import { withFixtureMongo } from './recovery-fixture';

test('recovered API keeps product and SKU identity through nested taxonomy and authoritative stock', async ({ page, request }) => {
  const path = '/bd/category/fixture-category/fixture-subcategory/fixture-cases/fixture-blue-cases';
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1, name: 'Fixture blue cases' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Fixture domestic case' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Fixture international case' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Fixture domestic case', exact: true }).click();
  await expect(page).toHaveURL(/\/bd\/product\/fixture-bd$/);
  await expect(page).toHaveTitle('Fixture domestic case · GriipBuddy');
  await expect(page.locator('.detail-sku')).toContainText('FIXTURE-BD-BLUE');
  await expect(page.locator('.detail-price')).toContainText('800');
  await expect(page.locator('.detail-price del')).toContainText('900');
  await expect(page.locator('.detail-stock')).toHaveText('In stock · 10 available');
  const items = await request.get('/api/catalog/items?market=BD&slug=fixture-bd');
  expect(items.ok()).toBe(true);
  expect((await items.json()).products[0]).toMatchObject({
    id: '000000000000000000000003', sku: 'FIXTURE-BD',
    category: ['fixture-category', 'fixture-subcategory', 'fixture-cases', 'fixture-blue-cases'],
    variants: [{ id: '000000000000000000000005', sku: 'FIXTURE-BD-BLUE' }],
  });
  expect((await request.get('/api/catalog/stock?market=BD&product=fixture-bd&variant=000000000000000000000006')).status()).toBe(404);
});

test('API country prices and original media references survive the storefront adapter', async ({ page, request }) => {
  const fixture = await request.get('/catalog/form-case.webp');
  const image = await fixture.body();
  const requestedImages = new Set<string>();
  await page.route('https://media.fixture.invalid/**', async (route) => {
    requestedImages.add(route.request().url());
    await route.fulfill({ contentType: 'image/webp', body: image });
  });
  await page.goto('/de/product/fixture-int');
  await expect(page.locator('.detail-price')).toContainText('€12');
  await expect(page.locator('.detail-price del')).toHaveText('€15');
  await expect(page.locator('.detail-stock')).toHaveText('In stock · 8 available');
  await expect(page.getByRole('button', { name: 'Show image 2' })).toBeVisible();
  await page.getByRole('button', { name: 'Show image 2' }).click();
  await expect(page.getByRole('img', { name: 'Fixture international case — image 2' })).toHaveAttribute('src', 'https://media.fixture.invalid/fixture-detail.webp');
  await expect.poll(() => requestedImages.has('https://media.fixture.invalid/fixture-detail.webp')).toBe(true);
  await expect(page.locator('img[src*="blocked.fixture.invalid"]')).toHaveCount(0);
  await expect(page.locator('.product-videos video')).toHaveCount(0);
  await page.getByText('Product videos', { exact: true }).click();
  const clip = page.locator('.product-videos video');
  await expect(clip).toHaveCount(1);
  await expect(clip).toHaveAttribute('src', 'https://media.fixture.invalid/fixture-case.mp4');
  await expect(clip).toHaveAttribute('preload', 'none');

  await page.getByRole('button', { name: 'Color: Graphite' }).click();
  await expect(page.locator('.detail-sku')).toContainText('FIXTURE-INT-GRAPHITE');
  await expect(page.locator('.detail-stock')).toHaveText('Unavailable in this market');
  await expect(page.locator('.detail-price')).toHaveCount(0);
  await expect(page.getByRole('img', { name: 'Fixture international case — image 1' }))
    .toHaveAttribute('src', 'https://media.fixture.invalid/fixture-graphite.webp');
  await page.getByRole('button', { name: /Choose country, current market/ }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: /Canada/ })).toHaveCount(0);
  await page.getByRole('dialog').getByRole('button', { name: /Fixture US/ }).click();
  await expect(page).toHaveURL(/\/product\/fixture-int\?variant=00000000000000000000006e$/);
  await expect(page.locator('.detail-price')).toContainText('$17');
  await expect(page.locator('.detail-stock')).toHaveText('Out of stock');
  await page.getByRole('button', { name: 'Color: Blue' }).click();
  await expect(page.locator('.detail-price')).toContainText('$14');
  await expect(page.locator('.detail-stock')).toHaveText('In stock · 8 available');

  await page.goto('/au/product/fixture-int');
  await expect(page.locator('.detail-stock')).toHaveText('Unavailable in this market');
  await expect(page.locator('.detail-price')).toHaveCount(0);
  await page.goto('/au/products');
  await expect(page.getByRole('heading', { name: 'No products found' })).toBeVisible();
});

test('API browsing denies unpublished, POS-only and out-of-region products', async ({ page, request }) => {
  for (const path of ['/bd/product/fixture-unpublished', '/bd/product/fixture-pos-only', '/product/fixture-bd', '/ca/product/fixture-int']) {
    expect((await request.get(path)).status()).toBe(404);
  }
  const hiddenCategory = '/bd/category/fixture-category/fixture-subcategory/fixture-cases/fixture-private';
  expect((await request.get(hiddenCategory)).status()).toBe(404);

  await page.goto('/bd/search?q=FIXTURE-BD-BLUE&brand=000000000000000000000068&availability=in');
  const results = page.getByRole('region', { name: 'Catalog results' });
  await expect(results.getByRole('heading', { name: 'Fixture domestic case' })).toBeVisible();
  await expect(results.getByRole('article')).toHaveCount(1);
  const suggestions = await request.get('/api/catalog/suggest?market=BD&q=FIXTURE-BD-BLUE');
  expect((await suggestions.json()).suggestions).toContainEqual({
    href: '/bd/product/fixture-bd', title: 'Fixture domestic case', kind: 'Product',
  });
});

test('coupon center presents active Bangladesh offers without exposing restricted or expired codes', async ({ page }) => {
  const now = Date.now();
  const expires = new Date(now + 3_600_000);
  const starts = new Date(now - 3_600_000);
  const code = 'FIXTURE-SAVE';
  const restricted = 'FIXTURE-PRIVATE';
  const expired = 'FIXTURE-EXPIRED';
  const identifiers = ['000000000000000000000170', '000000000000000000000171', '000000000000000000000172'];
  await withFixtureMongo(async (db, id) => {
    const sample = { isActive: true, discountType: 'FLAT', discountValue: 120, minOrderAmount: 1000, firstOrderOnly: true,
      categoryIds: [id('000000000000000000000001')], startAt: starts, expireAt: expires };
    const entries = [
      { ...sample, code },
      { ...sample, code: restricted, userIds: [id('00000000000000000000000f')] },
      { ...sample, code: expired, expireAt: new Date(now - 1_000) },
    ];
    for (const [index, offer] of entries.entries()) {
      await db.collection('coupons').updateOne({ _id: id(identifiers[index]) }, { $set: offer }, { upsert: true });
    }
  });

  try {
    await page.goto('/bd/coupons');
    const ticket = page.getByRole('article').filter({ has: page.getByRole('heading', { name: /120 off/ }) });
    await expect(ticket.getByRole('code')).toHaveText(code);
    await expect(page.getByRole('heading', { name: /(?:BDT|৳)\s*120 off/ })).toBeVisible();
    await expect(ticket.getByText('Selected items only')).toBeVisible();
    await expect(page.getByText(restricted, { exact: true })).toHaveCount(0);
    await expect(page.getByText(expired, { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Use in bag' })).toHaveCount(0);
    await page.goto('/us/coupons');
    await expect(page.getByRole('heading', { name: 'No active coupons' })).toBeVisible();
    await expect(page.getByText(code, { exact: true })).toHaveCount(0);
  } finally {
    await withFixtureMongo(async (db, id) => {
      for (const identifier of identifiers) {
        await db.collection('coupons').updateOne({ _id: id(identifier) }, { $set: { isActive: false } });
      }
    });
  }
});
