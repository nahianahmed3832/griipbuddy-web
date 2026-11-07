import { expect, test } from '@playwright/test';

test('market URLs outrank saved selection and detection, with International USD fallback', async ({ page, context }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.setExtraHTTPHeaders({ 'x-griipbuddy-country': 'BD' });
  await page.goto('/products?sort=price-asc');
  await expect(page).toHaveURL(/\/bd\/products\?sort=price-asc$/);
  await expect(page.getByRole('button', { name: 'Choose country, current market Bangladesh' })).toBeVisible();

  await page.getByRole('button', { name: /Choose country/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /United Kingdom/ }).click();
  await expect(page).toHaveURL(/\/gb\/products\?sort=price-asc$/);
  await page.goto('/us/products');
  await expect(page.getByRole('button', { name: 'Choose country, current market United States' })).toBeVisible();
  await page.goto('/products');
  await expect(page).toHaveURL(/\/gb\/products$/);

  await page.getByRole('button', { name: /Choose country/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Use automatic location' }).click();
  await expect(page).toHaveURL(/\/bd\/products$/);
  expect((await context.cookies()).find(cookie => cookie.name === 'griipbuddy-market')).toBeUndefined();

  await context.clearCookies();
  await page.setExtraHTTPHeaders({ 'x-griipbuddy-country': 'SG' });
  await page.goto('/product/form-case');
  await expect(page).toHaveURL(/\/international\/product\/form-case$/);
  await expect(page.locator('.detail-price')).toHaveText('$34');
  await page.getByRole('button', { name: 'Add to bag' }).click();
  const bag = page.getByRole('dialog', { name: 'Shopping bag' });
  await expect(bag.getByText('Choose a delivery country', { exact: true })).toBeVisible();
  await expect(bag.getByRole('button', { name: 'Review checkout' })).toBeDisabled();
});

test('drawer, quantity, coupon and checkout simulations use the same persisted bag', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/us/product/arc-bag');
  const add = page.getByRole('button', { name: 'Add to bag' });
  await add.click();
  const drawer = page.getByRole('dialog', { name: 'Shopping bag' });
  await expect(drawer.locator('.bag-estimate dd')).toHaveText('$93');
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();
  await page.getByRole('button', { name: 'Shopping bag, 1 item' }).click();
  await drawer.getByRole('button', { name: 'Increase quantity for The Arc Shoulder Bag' }).click();
  await expect(drawer.locator('.bag-estimate dd')).toHaveText('$179');
  await drawer.getByRole('link', { name: 'View shopping bag' }).click();
  await expect(page).toHaveURL(/\/us\/cart$/);

  const summary = page.getByRole('region', { name: 'Bag summary' });
  await summary.getByLabel('Coupon code').fill('invalid');
  await summary.getByRole('button', { name: 'Apply' }).click();
  await expect(summary.getByText('This coupon is invalid for the current market.')).toBeVisible();
  await summary.getByLabel('Coupon code').fill('preview10');
  await summary.getByRole('button', { name: 'Apply' }).click();
  await expect(summary.getByText('Coupon applied.')).toBeVisible();
  await expect(summary.locator('.bag-estimate dd')).toHaveText('$161.80');

  await page.reload();
  await expect(page.getByRole('spinbutton', { name: 'Quantity for The Arc Shoulder Bag' })).toHaveValue('2');
  await expect(summary.locator('.bag-estimate dd')).toHaveText('$161.80');
  await summary.getByRole('link', { name: 'Review checkout' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Review checkout' })).toBeVisible();
  await expect(summary.locator('.bag-estimate dd')).toHaveText('$161.80');
  const simulate = summary.getByRole('button', { name: 'Run payment simulation' });
  await simulate.click();
  await expect(summary.getByText('Simulated payment approved.')).toBeVisible();
  await summary.getByLabel('Test outcome').selectOption('decline');
  await simulate.click();
  await expect(summary.getByText('Simulated payment declined.')).toBeVisible();
  await page.getByRole('link', { name: 'Edit shopping bag' }).click();
  await page.getByRole('button', { name: 'Remove The Arc Shoulder Bag' }).click();
  await expect(page.getByRole('heading', { name: 'Your bag is empty' })).toBeVisible();
});

test('mobile bag reprices its exact variants, keeps unavailable lines, and blocks review', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/us/product/weekday-tee');
  await page.getByRole('button', { name: 'Size: M' }).click();
  await page.getByRole('button', { name: 'Add to bag' }).click();
  await page.getByRole('button', { name: 'Close shopping bag' }).click();
  await page.goto('/us/product/form-case?variant=form-case-plus');
  await expect(page.getByRole('button', { name: 'Add to bag' })).toBeDisabled();
  await page.getByRole('button', { name: 'Size: Standard' }).click();
  await page.getByRole('button', { name: 'Add to bag' }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'View shopping bag' }).click();
  await expect(page).toHaveURL(/\/us\/cart$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Shopping bag' })).toBeVisible();

  await page.getByRole('button', { name: /Choose country/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /United Kingdom/ }).click();
  await expect(page).toHaveURL(/\/gb\/cart$/);
  const items = page.getByRole('region', { name: 'Bag items' });
  await expect(items.getByText('£28 each')).toBeVisible();
  await expect(items.getByText('Price unavailable in this market')).toBeVisible();
  await expect(items.getByText('SKU DEMO-WEEKDAY-TEE-M')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review checkout' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);

  await items.getByRole('button', { name: 'Remove Weekday Tee' }).click();
  const quantity = items.getByRole('spinbutton', { name: 'Quantity for The Form Case' });
  await quantity.fill('9');
  await quantity.press('Enter');
  await expect(items.getByText('Only 8 available. Reduce quantity to continue.')).toBeVisible();
  await quantity.fill('2');
  await quantity.press('Enter');
  await expect(items.getByText('£56', { exact: true })).toBeVisible();
  await expect(page.getByText('Shipping not configured')).toBeVisible();
});

test('quote ignores submitted totals and rejects malformed quantities and duplicate identities', async ({ request }) => {
  const line = { productId: 'fixture-form-case', variantId: 'form-case-std', slug: 'form-case', quantity: 2 };
  const post = (lines: unknown[]) => request.post('/api/cart/quote', {
    data: { market: 'US', lines, estimatedTotal: 1, shipping: 0, preview: 'approve' },
  });
  const blocked = await request.post('/api/cart/quote', {
    headers: { origin: 'https://other.invalid' }, data: { market: 'US', lines: [line] },
  });
  expect(blocked.status()).toBe(403);
  const response = await post([{ ...line, unit: 1, price: 1 }]);
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ subtotal: 6800, estimatedTotal: 7500, reviewReady: true, paymentPreview: 'approved' });
  for (const invalid of [0, -1, 1.5, '2', 101]) expect((await post([{ ...line, quantity: invalid }])).status()).toBe(400);
  expect((await post([line, line])).status()).toBe(400);
  const excessive = await post([{ ...line, quantity: 9 }]);
  expect(await excessive.json()).toMatchObject({ estimatedTotal: null, reviewReady: false, lines: [{ status: 'insufficient' }] });
  const mismatched = await post([{ ...line, variantId: 'arc-bag-espresso' }]);
  expect(await mismatched.json()).toMatchObject({ estimatedTotal: null, reviewReady: false, lines: [{ status: 'unavailable' }] });
});


test('product quantity adds the selected number of units up to remaining variant stock', async ({ page }) => {
  await page.goto('/us/product/form-case');
  const detail = page.locator('.detail-copy');
  const quantity = detail.getByRole('combobox', { name: 'Quantity' });
  await expect(quantity.locator('option')).toHaveCount(8);
  await quantity.selectOption('3');
  await detail.getByRole('button', { name: 'Add to bag', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Shopping bag' });
  await expect(drawer.getByRole('spinbutton', { name: 'Quantity for The Form Case' })).toHaveValue('3');
  await drawer.getByRole('button', { name: 'Close shopping bag' }).click();
  await expect(quantity.locator('option')).toHaveCount(5);
  await expect(quantity).toHaveValue('1');
});
