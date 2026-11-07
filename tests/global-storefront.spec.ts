import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';

test('quick view, comparison and watchlist keep the selected market and variant', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/us/products');
  const trigger = page.getByRole('button', { name: 'Quick view The Form Case' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'The Form Case' });
  await dialog.getByLabel('Options').selectOption('form-case-plus');
  await expect(dialog.getByText('$39', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await page.getByRole('button', { name: 'Compare The Form Case' }).click();
  await page.getByRole('button', { name: 'Compare Studio Frames' }).click();
  await page.getByRole('link', { name: 'Compare (2)' }).click();
  await expect(page.getByRole('heading', { name: 'Compare products' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Studio Frames' })).toBeVisible();
  await page.getByRole('button', { name: 'Remove Studio Frames from comparison' }).click();
  await expect(page.getByRole('heading', { name: 'Studio Frames' })).toHaveCount(0);
  await page.getByRole('link', { name: 'The Form Case', exact: true }).click();
  await page.getByRole('button', { name: 'Add to watchlist' }).click();
  await page.getByText('Save to collection', { exact: true }).click();
  await page.getByLabel('New collection name').fill('Weekend kit');
  await page.getByRole('button', { name: 'Create and save' }).click();
  await expect(page.getByText('Saved to Weekend kit.')).toBeVisible();
  await page.goto('/us/wishlist');
  const collection = page.getByRole('region', { name: 'Saved collections' });
  await collection.getByRole('button', { name: 'Weekend kit' }).click();
  await expect(collection.getByRole('link', { name: 'The Form Case' })).toBeVisible();
  await page.goto('/us/discover');
  await expect(page.getByRole('region', { name: 'Product watchlist' }).getByRole('link', { name: 'The Form Case' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Pick up where you left off' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear history' }).click();
  await expect(page.getByRole('region', { name: 'Pick up where you left off' })).toHaveCount(0);
});

test('group preview persists on this device and closes on its scheduled end', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-11-08T02:00:00Z') });
  await page.goto('/us/group-buy');
  await expect(page.getByText('SYNTHETIC DEVELOPMENT PREVIEW', { exact: true })).toBeVisible();
  await expect(page.getByRole('timer')).toBeVisible();
  await page.getByRole('button', { name: 'Join sample group' }).click();
  await expect(page.getByRole('progressbar')).toHaveAttribute('value', '2');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Leave sample group' })).toBeEnabled();
  await page.clock.setSystemTime(new Date('2027-01-01T00:00:01Z'));
  await page.clock.runFor(1000);
  await expect(page.getByText('Campaign ended')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Leave sample group' })).toBeDisabled();
  await page.goto('/gb/group-buy');
  await expect(page.getByRole('heading', { name: 'No group offers in this market' })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveCount(0);
});

test('coupon wallet saves only for the current market and uses the authoritative sample quote', async ({ page }) => {
  await page.goto('/us/product/arc-bag');
  await page.getByRole('button', { name: 'Add to bag' }).click();
  await expect(page.getByRole('dialog', { name: 'Shopping bag' })).toBeVisible();
  await page.goto('/us/coupons');
  await page.getByRole('button', { name: 'Save coupon', exact: true }).click();
  await page.getByRole('button', { name: 'Saved on this device' }).click();
  await expect(page.getByRole('heading', { name: '10% off' })).toBeVisible();
  await page.getByRole('button', { name: 'Use in bag' }).click();
  await expect(page.getByText('PREVIEW10 added to your bag.')).toBeVisible();
  await page.getByRole('link', { name: 'View your shopping bag' }).click();
  await expect(page.getByText('Coupon discount', { exact: true })).toBeVisible();
  await page.goto('/gb/coupons');
  await expect(page.getByRole('heading', { name: 'No active coupons' })).toBeVisible();
  await expect(page.getByText('PREVIEW10')).toHaveCount(0);
});

test('marketplace routes fit phone and tablet and expose accessible landmarks', async ({ page }) => {
  test.setTimeout(90000);
  for (const [width, route, title] of [
    [390, '/us/deals', 'Deals'], [834, '/us/group-buy', 'Group Buy'], [390, '/us/coupons', 'Coupon center'],
    [390, '/us/discover', 'Discover'], [834, '/us/rewards', 'Rewards'], [320, '/us/compare', 'Compare products'],
    [834, '/us/collections/sale', 'Sale'], [390, '/us/checkout', 'Review checkout'], [390, '/us/login', 'Sign in'],
  ] as const) {
    await page.setViewportSize({ width, height: 920 });
    const response = await page.goto(route);
    expect(response?.status(), route).toBe(200);
    await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth), route).toBe(width);
    const scan = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
    expect(scan.violations.filter(({ impact }) => impact === 'serious' || impact === 'critical')
      .map(({ id, nodes }) => ({ id, nodes: nodes.map(({ target }) => target) })), route).toEqual([]);
  }
});
