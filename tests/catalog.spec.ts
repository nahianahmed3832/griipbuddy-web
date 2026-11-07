import { expect, test } from '@playwright/test';

test('catalog filters and sorts matching variants by the selected market price', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/gb/products');
  const filters = page.getByRole('complementary', { name: 'Catalog filters' });
  await filters.getByLabel('Category').selectOption('technology');
  await filters.getByLabel('Brand').selectOption('Studio Sample');
  await filters.getByLabel('Size').selectOption('Plus');
  await filters.getByLabel('Color').selectOption('Cobalt');
  await filters.getByLabel('Min', { exact: true }).fill('30');
  await filters.getByLabel('Max', { exact: true }).fill('34');
  await filters.getByLabel('Availability').selectOption('out');
  await filters.getByRole('button', { name: 'Apply filters' }).click();
  const results = page.getByRole('region', { name: 'Catalog results' });
  await expect(results.getByRole('heading', { level: 3 })).toHaveCount(1);
  const card = results.getByRole('article');
  await expect(card.getByText('£33')).toBeVisible();
  await expect(card.getByText('Out of Stock', { exact: true })).toBeVisible();
  await expect(card.getByRole('link')).toHaveCount(1);
  await results.getByRole('link', { name: 'Remove filter: Color: Cobalt' }).click();
  await expect(results.getByRole('link', { name: 'Remove filter: Color: Cobalt' })).toHaveCount(0);
  await expect(results.getByRole('link', { name: 'Remove filter: Size: Plus' })).toBeVisible();
  await card.getByRole('link', { name: 'The Form Case', exact: true }).click();
  await expect(page).toHaveURL(/\/gb\/product\/form-case\?variant=form-case-plus$/);
  await expect(page.getByText('DEMO-FORM-CASE-PLUS')).toBeVisible();

  await page.goto('/gb/products');
  await page.getByRole('combobox', { name: 'Sort by' }).selectOption('price-desc');
  await page.getByRole('button', { name: 'Sort', exact: true }).click();
  await expect(results.getByRole('heading', { level: 3 }).first()).toHaveText('The Arc Shoulder Bag');
  await expect(results.getByRole('heading', { level: 3 }).last()).toHaveText('The Form Case');

  await page.goto('/gb/products?min=35&sort=price-desc');
  await page.getByRole('button', { name: /Choose country, current market/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /Bangladesh/ }).click();
  await expect(page).toHaveURL(/\/bd\/products\?sort=price-desc$/);
});

test('mobile gallery and variant selection update image, price, SKU and stock', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/us/category/technology');
  const filter = page.locator('.catalog-filter-panel');
  await expect(filter.getByRole('button', { name: 'Apply filters' })).toBeHidden();
  await filter.getByText('Filters', { exact: true }).click();
  await expect(filter.getByRole('button', { name: 'Apply filters' })).toBeVisible();
  await page.goto('/us/product/form-case');
  const detail = page.locator('.detail-grid');
  await expect(detail.getByText('$34', { exact: true })).toBeVisible();
  await expect(detail.getByText('In stock · 8 available')).toBeVisible();
  await expect(detail.getByText('DEMO-FORM-CASE-STD')).toBeVisible();
  await detail.getByRole('button', { name: 'Show image 2' }).click();
  const zoomTrigger = detail.getByRole('button', { name: 'Zoom image 2' });
  await zoomTrigger.click();
  const zoom = page.getByRole('dialog', { name: 'Product image zoom' });
  await expect(zoom.getByRole('img')).toBeVisible();
  await zoom.getByRole('button', { name: 'Zoom in' }).click();
  await expect(zoom.getByRole('button', { name: 'Zoom out' })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect(zoom).toBeHidden();
  await expect(zoomTrigger).toBeFocused();

  await detail.getByRole('button', { name: 'Size: Plus' }).click();
  await expect(detail.getByRole('button', { name: 'Material: TPU' })).toHaveAttribute('aria-pressed', 'true');
  await expect(detail.getByText('$39', { exact: true })).toBeVisible();
  await expect(detail.getByText('DEMO-FORM-CASE-PLUS')).toBeVisible();
  await expect(detail.locator('.detail-stock')).toHaveText('Out of stock');
  await expect(detail.getByRole('img', { name: 'The Form Case — image 1' })).toHaveAttribute('src', /technology.webp/);
  await expect(page).toHaveURL(/variant=form-case-plus$/);
  await page.reload();
  await expect(detail.getByRole('button', { name: 'Size: Plus' })).toHaveAttribute('aria-pressed', 'true');
  await detail.getByText('Specifications', { exact: true }).click();
  await expect(detail.getByText('Matte', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('scoped autocomplete supports keyboard selection and recent items stay market eligible', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/us/product/day-bottle');
  await expect(page.locator('.detail-stock')).toHaveText('Out of stock');
  const header = page.getByRole('search', { name: 'Storefront search' });
  await header.getByRole('combobox', { name: 'Search category' }).selectOption('bags');
  const search = header.getByRole('combobox', { name: 'Search products' });
  await search.fill('arc');
  await expect(header.getByRole('option', { name: /The Arc Shoulder Bag/ })).toBeVisible();
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(page).toHaveURL(/\/product\/arc-bag$/);
  const related = page.getByRole('region', { name: 'Related products' });
  await expect(related.getByRole('heading', { name: 'The Market Tote' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'You may also like' })).toBeVisible();
  const recent = page.getByRole('region', { name: 'Recently viewed' });
  await expect(recent.getByRole('heading', { name: 'Day Bottle' })).toBeVisible();
  await page.goto('/gb/product/arc-bag');
  await expect(page.locator('.detail-price')).toHaveText('£72');
  await expect(recent).toHaveCount(0);
  await expect(page.locator('.detail-badges').getByText('Sale', { exact: true })).toHaveCount(0);
});
