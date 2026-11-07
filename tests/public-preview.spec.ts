import { expect, test } from '@playwright/test';

test('public sample browsing and payment simulation need no login and expose no write flows', async ({ page, request }) => {
  await page.goto('/bd');
  await expect(page.getByText('Sample storefront · Explore the catalog')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Account', exact: true })).toHaveCount(0);
  await page.goto('/bd/login');
  await expect(page).toHaveURL(/\/bd\/products$/);
  await page.goto('/bd/product/form-case-standard');
  await page.getByRole('button', { name: 'Add to bag', exact: true }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Review checkout' }).click();
  await page.getByRole('button', { name: 'Run payment simulation' }).click();
  await expect(page.getByText('Simulated payment approved.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in to check out' })).toHaveCount(0);
  for (const path of ['/api/account/login', '/api/account/wishlist', '/api/checkout/place', '/api/reviews/submit']) {
    expect((await request.post(path, { data: {} })).status(), path).toBe(404);
  }
});
