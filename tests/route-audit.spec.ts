import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { collections, flattenCategories } from '../src/features/catalog/catalog';
import { fixtureCategories, fixtureMarkets, fixtureProducts } from '../src/features/catalog/fixtures';

const bd = fixtureMarkets.find(market => market.code === 'BD')!;
const browse = [
  '/bd', '/bd/products', '/bd/search?q=case', '/bd/search?q=not-a-product',
  ...collections.map(collection => '/bd/collections/' + collection.id),
  ...flattenCategories(fixtureCategories).map(category => '/bd/category/' + category.path.join('/')),
  ...fixtureProducts(bd).map(product => '/bd/product/' + product.slug),
  '/bd/wishlist', '/bd/cart', '/bd/checkout', '/bd/login', '/bd/account/register', '/bd/account/recover',
  ...['about-us', 'contact-and-support', 'shipping-procedure', 'returns-and-exchange', 'privacy-and-policy', 'terms-and-conditions']
    .map(slug => '/bd/' + slug),
  '/us', '/us/products', '/gb', '/gb/products', '/international', '/international/products',
];

const representative = ['/bd', '/bd/products', '/bd/category/technology/phone-cases', '/bd/product/form-case',
  '/bd/search?q=case', '/bd/wishlist', '/bd/cart', '/bd/checkout', '/bd/login', '/us/products', '/gb/products'];

test('all browse and information routes render, with commerce entry points fitting phone and tablet widths', async ({ page }) => {
  test.setTimeout(120_000);
  const output = process.env.GRIIPBUDDY_SCREENSHOTS;
  if (output) await mkdir(output, { recursive: true });
  for (const [width, height, paths] of [[1440, 1000, browse], [834, 1112, representative], [390, 932, representative]] as const) {
    await page.setViewportSize({ width, height });
    for (const path of paths) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      await expect(page.getByRole('heading', { level: 1 }), path).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${path} @ ${width}`).toBeLessThanOrEqual(width);
      if (output && ((width === 1440 && path === '/bd') || (width === 834 && path === '/us/products') ||
        (width === 390 && path === '/bd/product/form-case'))) {
        await page.evaluate(() => document.fonts.ready);
        const name = path === '/bd' ? 'storefront-home-desktop' : width === 834 ? 'storefront-catalog-tablet' : 'storefront-product-mobile';
        await page.screenshot({ path: join(output, name + '.jpg'), type: 'jpeg', quality: 87, animations: 'disabled' });
      }
    }
  }
});
