import { expect, test } from '@playwright/test';

test('desktop category menu opens, closes with Escape and navigates', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/us');
  await expect(page.getByRole('heading', { level: 1, name: /Good finds.*Great grip/ })).toBeVisible();
  await expect(page.getByRole('link', { name: 'GriipBuddy home', exact: true }).first()).toBeVisible();
  const category = page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Technology' });
  await category.click();
  await expect(category).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(category).toBeFocused();
  await expect(category).toHaveAttribute('aria-expanded', 'false');
  await category.click();
  await page.getByRole('link', { name: 'Shop all technology' }).click();
  await expect(page).toHaveURL(/\/category\/technology$/);
  await expect(page.getByRole('heading', { name: 'Technology', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'The Form Case' })).toBeVisible();
});

test('search, saved items and market changes use the fixture catalog', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/us');
  const search = page.getByRole('search', { name: 'Storefront search' }).getByRole('combobox', { name: 'Search products' });
  await expect(search).toBeVisible();
  await search.fill('arc');
  await search.press('Enter');
  await expect(page).toHaveURL(/\/search\?.*q=arc$/);
  await page.getByRole('link', { name: 'The Arc Shoulder Bag', exact: true }).click();
  await page.getByRole('button', { name: 'Save The Arc Shoulder Bag' }).click();
  await expect(page.getByRole('button', { name: 'Remove The Arc Shoulder Bag' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('link', { name: 'Wishlist' }).click();
  await expect(page).toHaveURL(/\/wishlist$/);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'The Arc Shoulder Bag' })).toBeVisible();
  await page.getByRole('button', { name: /Choose country, current market/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /United Kingdom/ }).click();
  await expect(page).toHaveURL(/\/gb\/wishlist$/);
  await expect(page.getByText('£72')).toBeVisible();
  await page.getByRole('button', { name: 'Remove The Arc Shoulder Bag' }).click();
  await expect(page.getByRole('heading', { name: 'No saved items in this market' })).toBeVisible();
});

test('market navigation keeps the browse route and excludes products without a local price', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/us/collections/best-sellers');
  await expect(page.getByRole('heading', { name: 'Day Bottle' })).toBeVisible();
  await page.getByRole('button', { name: /Choose country, current market/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: /United Kingdom/ }).click();
  await expect(page).toHaveURL(/\/gb\/collections\/best-sellers$/);
  await expect(page.getByRole('heading', { name: 'Day Bottle' })).toHaveCount(0);
  await expect(page.getByText('£72')).toBeVisible();
  await page.goto('/gb/product/day-bottle');
  await expect(page.getByText('Unavailable in this market')).toBeVisible();
  await page.goto('/gb');
  await page.getByRole('navigation', { name: 'Quick browse' }).getByRole('link', { name: 'Fashion' }).click();
  await page.getByRole('navigation', { name: 'Subcategories' }).getByRole('link', { name: 'Sunglasses' }).click();
  await expect(page).toHaveURL(/\/gb\/category\/fashion\/sunglasses$/);
  await expect(page.getByRole('heading', { name: 'Studio Frames' })).toBeVisible();
});

test('mobile tabs link to home, cart and profile while the header supports browse and search', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/bd');
  const nav = page.getByRole('navigation', { name: 'Mobile navigation' });
  await expect(nav).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await expect(nav.getByRole('link')).toHaveText(['Home', 'Cart', 'Profile']);
  const headerSearch = page.getByRole('search', { name: 'Storefront search' });
  const search = headerSearch.getByRole('combobox', { name: 'Search products' });
  await search.click();
  await expect(search).toBeFocused();
  await search.fill('arc');
  const suggestion = headerSearch.getByRole('link', { name: 'The Arc Shoulder Bag' });
  await expect(suggestion).toBeVisible();
  await expect(suggestion.locator('img')).toHaveAttribute('src', /catalog/);
  await page.keyboard.press('Escape');
  await expect(search).toBeFocused();
  await page.getByRole('button', { name: 'Browse categories' }).click();
  const browse = page.getByRole('dialog', { name: 'Browse' });
  await browse.locator('summary').getByText('Fashion', { exact: true }).click();
  await browse.getByRole('link', { name: 'Sunglasses', exact: true }).click();
  await expect(page).toHaveURL(/\/bd\/category\/fashion\/sunglasses$/);
  await expect(page.getByRole('heading', { name: 'Studio Frames' })).toBeVisible();
  await nav.getByRole('link', { name: 'Cart' }).click();
  await expect(page).toHaveURL(/\/bd\/cart$/);
  await expect(page.getByRole('heading', { name: 'Your bag is empty' })).toBeVisible();
  await nav.getByRole('link', { name: 'Profile' }).click();
  await expect(page.getByRole('heading', { name: 'Profile', exact: true })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Profile' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('region', { name: 'Your shopping' }).getByRole('link', { name: /Saved items/ }).click();
  await expect(page).toHaveURL(/\/bd\/wishlist$/);
});

test('recent search is market-scoped, keyboard selectable and clearable', async ({ page }) => {
  await page.goto('/us');
  const search = page.getByRole('search', { name: 'Storefront search' }).getByRole('combobox', { name: 'Search products' });
  await search.fill('arc');
  await search.press('Enter');
  await expect(page).toHaveURL(/\/us\/search\?q=arc$/);
  await search.focus();
  await expect(page.getByRole('listbox', { name: 'Recent searches' })).toBeVisible();
  await search.press('ArrowDown');
  await search.press('Enter');
  await expect(page).toHaveURL(/\/us\/search\?q=arc$/);
  await page.goto('/bd');
  await search.focus();
  await expect(page.getByRole('listbox', { name: 'Recent searches' })).toHaveCount(0);
  await page.goto('/us');
  await search.focus();
  await page.getByRole('button', { name: 'Clear recent searches' }).click();
  await expect(page.getByRole('listbox', { name: 'Recent searches' })).toHaveCount(0);
});

test('tablet homepage loads local images and presents all sections without overflow', async ({ page, baseURL }) => {
  await page.setViewportSize({ width: 834, height: 1112 });
  const offOrigin: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('http') && new URL(request.url()).origin !== baseURL) offOrigin.push(request.url());
  });
  await page.goto('/us');
  for (const name of ['Shop by category', 'New Arrivals', 'Best Sellers', 'Trending Now', 'Bags for every day.']) {
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('img', { name: /cream headphones, a cobalt bag/i })).toBeVisible();
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 252, 248)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(834);
  expect(offOrigin).toEqual([]);
});
