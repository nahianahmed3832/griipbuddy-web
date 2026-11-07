import { expect, test } from '@playwright/test';

test('recovered catalog quotes real fixture IDs, regional prices and reservation-adjusted stock', async ({ request, page }) => {
  const bd = { productId: '000000000000000000000003', variantId: '000000000000000000000005', slug: 'fixture-bd', quantity: 1 };
  const intl = { productId: '000000000000000000000004', variantId: '000000000000000000000006', slug: 'fixture-int', quantity: 1 };
  const getQuote = async (market: string, line: typeof bd) => {
    const response = await request.post('/api/cart/quote', { data: { market, lines: [line], coupon: 'PREVIEW10', preview: 'approve' } });
    expect(response.ok()).toBe(true);
    return response.json();
  };

  expect(await getQuote('BD', bd)).toMatchObject({
    currency: 'BDT', lines: [{ sku: 'FIXTURE-BD-BLUE', available: 10, unit: 80000, regular: 90000, status: 'ready' }],
    estimatedTotal: 88000, paymentPreview: 'approved', coupon: { status: 'unavailable' },
  });
  expect(await getQuote('US', bd)).toMatchObject({ lines: [{ status: 'unavailable' }], estimatedTotal: null });
  expect(await getQuote('US', intl)).toMatchObject({ currency: 'USD', lines: [{ unit: 1400, status: 'ready', available: 8 }] });
  expect(await getQuote('DE', intl)).toMatchObject({ currency: 'EUR', lines: [{ unit: 1200, status: 'ready', available: 8 }] });
  expect(await getQuote('US', { ...intl, variantId: '00000000000000000000006e' })).toMatchObject({ lines: [{ unit: 1700, status: 'out' }] });
  expect(await getQuote('AU', intl)).toMatchObject({ lines: [{ status: 'unpriced' }], reviewReady: false });
  expect(await getQuote('INTL', intl)).toMatchObject({
    currency: 'USD', lines: [{ unit: 1400 }], shipping: { status: 'destination-required' }, estimatedTotal: null,
  });

  await page.goto('/bd/product/fixture-bd');
  await page.getByRole('button', { name: 'Add to bag' }).click();
  const drawer = page.getByRole('dialog', { name: 'Shopping bag' });
  await expect(drawer.locator('.bag-estimate dd')).toContainText('880');
  await drawer.getByRole('link', { name: 'Review checkout' }).click();
  await page.getByRole('button', { name: 'Run payment simulation' }).click();
  await expect(page.getByText('Simulated payment approved.')).toBeVisible();

  const stock = await request.get('/api/catalog/stock?market=BD&product=fixture-bd&variant=' + bd.variantId);
  expect(await stock.json()).toEqual({ stock: 10 });
});

test('recovered API mode keeps checkout writes and simulator callbacks disabled', async ({ request }) => {
  expect((await request.post('/api/checkout/session')).status()).toBe(404);
  expect((await request.post('/api/checkout/place', { data: {} })).status()).toBe(404);
  expect((await request.post('/api/checkout/webhook/stripe', { data: {} })).status()).toBe(404);
});
