import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';
import { withFixtureMongo } from './recovery-fixture';

const api = 'http://127.0.0.1:38100/api/v1';
const caseId = '000000000000000000000003';
const historicalOrder = '00000000000000000000000a';
const sampleReview = 'Fixture review with photo and video';

function password() {
  const value = process.env.GRIIPBUDDY_TEST_FIXTURE_PASSWORD;
  if (!value) throw new Error('Set GRIIPBUDDY_TEST_FIXTURE_PASSWORD from the local fixture.');
  return value;
}

async function signIn(page: Page) {
  await page.goto('/bd/login');
  await page.getByLabel('Phone number', { exact: true }).fill('01000000002');
  await page.getByLabel('Password', { exact: true }).fill(password());
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/bd\/account$/);
}

async function capture(page: Page, name: string) {
  const directory = process.env.GRIIPBUDDY_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(directory, name + '.jpg'), type: 'jpeg', quality: 87, animations: 'disabled' });
}

test('linked cases, accessory selection and clothing fit stay within the active market', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 932 });
  await page.goto('/bd/product/form-case-standard');
  const family = page.getByRole('region', { name: 'Model or style' });
  await expect(family.getByRole('link', { name: 'Standard' })).toHaveAttribute('aria-current', 'page');
  await expect(family.getByRole('combobox')).toHaveCount(0);
  await family.getByRole('link', { name: 'Plus', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'The Form Case Plus', exact: true, level: 1 })).toBeVisible();
  await expect(family.getByRole('link', { name: 'Plus', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Complete the set' })).toBeVisible();
  await page.getByRole('button', { name: 'Add The Market Tote to bag', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Shopping bag' }).getByRole('link', { name: 'The Market Tote' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Shopping bag' }).getByRole('link', { name: 'Review checkout' }).click();
  await expect(page.getByRole('link', { name: 'Sign in to check out' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Run payment simulation' })).toHaveCount(0);
  await page.goto('/bd/product/weekday-tee-preview');
  await page.getByRole('button', { name: 'Fit: Tall' }).click();
  await expect(page.getByRole('button', { name: 'Size: M' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Size: L' })).toBeDisabled();
  await expect(page.locator('.detail-stock')).toContainText('5 available');
  const size = page.getByRole('button', { name: 'Size guide' });
  await size.click();
  const guide = page.getByRole('dialog', { name: 'Size guide' });
  await guide.getByRole('button', { name: 'Inches', exact: true }).click();
  await expect(guide.getByRole('columnheader', { name: 'Width (in)' }).first()).toBeVisible();
  await expect(guide.getByRole('cell', { name: '18.9', exact: true })).toBeVisible();
  await capture(page, 'size-guide-mobile');
  await guide.getByRole('button', { name: 'How to measure' }).click();
  await expect(guide.getByText(/Lay the garment flat/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(size).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('recovered buyer can place a COD test order when the estimate excludes an unsupported coupon', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await signIn(page);
  await page.goto('/bd/product/market-tote-preview');
  await page.getByRole('button', { name: 'Add to bag', exact: true }).click();
  await page.getByRole('dialog').getByRole('link', { name: 'Review checkout' }).click();
  const summary = page.getByRole('region', { name: 'Bag summary' });
  await summary.getByLabel('Coupon code').fill('PREVIEW10');
  await summary.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(summary.getByText('Coupon validation is unavailable for this catalog.')).toBeVisible();
  await page.getByLabel('Recipient name').fill('Fixture Recipient');
  await page.getByLabel('Delivery phone').fill('01000000002');
  await page.getByLabel('Street address').fill('123 Fixture Avenue');
  await page.getByLabel('City', { exact: true }).fill('Dhaka');
  await page.getByLabel('District', { exact: true }).fill('Dhaka');
  await expect(page.getByRole('radio', { name: /Cash on delivery/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: /PayPal/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Quick payment/ })).toHaveCount(0);
  await capture(page, 'checkout-integrated-desktop');
  await page.setViewportSize({ width: 390, height: 932 });
  await expect(summary.locator('.checkout-items')).not.toHaveAttribute('open');
  await expect(summary.getByText('Estimated total before tax')).toBeVisible();
  await capture(page, 'checkout-integrated-mobile');
  const placed = page.waitForResponse(response => response.url().endsWith('/api/checkout/place'));
  await page.getByRole('button', { name: /Place test order/ }).click();
  expect((await placed).status()).toBe(201);
  await expect(page).toHaveURL(/\/bd\/order\/[a-f0-9]{24}$/);
  await expect(page.getByText('Order placed · Due on delivery')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel order', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm cancellation' }).click();
  await expect(page.getByText('Cancelled · Voided')).toBeVisible();
});

test('review upload limits, moderation, photo and video ranges work through the recovered backend', async ({ page, request }) => {
  test.setTimeout(60_000);
  await signIn(page);
  const previous = await withFixtureMongo(async (db, id) => {
    const orders = db.collection('orders');
    const order = await orders.findOne({ _id: id(historicalOrder), order_serial_id: 990001 });
    if (!order || order.status !== 'IN_TRANSIT') throw new Error('Run review tests with the fresh historical fixture.');
    await orders.updateOne({ _id: id(historicalOrder) }, { $set: { status: 'DELIVERED', createdAt: new Date() } });
    return order.createdAt;
  });
  try {
    await page.goto('/bd/product/fixture-bd#product-reviews');
    await page.getByRole('button', { name: 'Write a review' }).click();
    const form = page.getByRole('dialog', { name: 'Write a review' });
    await form.getByRole('combobox', { name: 'Rating', exact: true }).selectOption('5');
    await form.getByLabel('Title (optional)').fill(sampleReview);
    await form.getByLabel('Your review').fill('The finish feels smooth. This review is a local fixture.');
    const largePhoto = { name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) };
    await form.getByLabel('Photos', { exact: true }).setInputFiles(largePhoto);
    await form.getByRole('button', { name: 'Submit review' }).click();
    await expect(form.getByRole('alert')).toContainText('2 MB');
    const oversized = await page.request.post('/api/reviews/submit', { multipart: {
      product: caseId, order: historicalOrder, rating: '5', title: sampleReview, content: 'Local oversized test.', media: largePhoto,
    } });
    expect(oversized.status()).toBe(413);
    const photo = await sharp({ create: { width: 96, height: 96, channels: 3, background: '#56384f' } }).png().toBuffer();
    const video = execFileSync(process.env.FFMPEG_BIN || 'ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i',
      'color=c=navy:s=96x96:r=24:d=0.3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags',
      'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']);
    await form.getByLabel('Photos', { exact: true }).setInputFiles({ name: 'sample.png', mimeType: 'image/png', buffer: photo });
    await form.getByLabel('Video', { exact: true }).setInputFiles({ name: 'sample.mp4', mimeType: 'video/mp4', buffer: video });
    await form.getByRole('button', { name: 'Submit review' }).click();
    await expect(form.getByText('Review submitted. It will appear after moderation.')).toBeVisible({ timeout: 20_000 });
    const reviewId = await withFixtureMongo(async db => String((await db.collection('reviews').findOne({ title: sampleReview }))?._id));
    expect(reviewId).toMatch(/^[a-f0-9]{24}$/);
    const url = '/api/reviews/media?id=' + reviewId;
    expect((await request.get(url + '&index=0')).status()).toBe(404);
    const staff = await request.post(api + '/user/admin/login', { data: { phone_number: '01000000001', password: password() } });
    expect(staff.ok()).toBe(true);
    const token = (await staff.json()).data.access_token;
    const approved = await request.patch(api + '/storefront-reviews/admin/' + reviewId, {
      headers: { Authorization: 'Bearer ' + token }, data: { status: 'approved' },
    });
    expect(approved.status()).toBe(200);
    expect((await request.get(url + '&index=0')).headers()['content-type']).toBe('image/jpeg');
    const range = await request.get(url + '&index=1', { headers: { Range: 'bytes=0-31' } });
    expect(range.status()).toBe(206);
    expect((await range.body()).length).toBe(32);
    await page.reload();
    await expect(page.getByRole('heading', { name: sampleReview, exact: true })).toBeVisible();
    await expect(page.locator('#product-reviews').getByText('Verified purchase')).toBeVisible();
    await page.getByRole('heading', { name: sampleReview, exact: true }).scrollIntoViewIfNeeded();
    await capture(page, 'reviews-desktop');
  } finally {
    await withFixtureMongo(async (db, id) => db.collection('orders').updateOne({ _id: id(historicalOrder) }, {
      $set: { status: 'IN_TRANSIT', ...(previous ? { createdAt: previous } : {}) }, ...(!previous && { $unset: { createdAt: 1 } }),
    }));
  }
});
