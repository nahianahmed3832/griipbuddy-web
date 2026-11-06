import { randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const api = 'http://127.0.0.1:38100/api/v1';
const ownerId = '00000000000000000000000f';
const ownedOrder = '00000000000000000000000a';
const wrongOwnerOrder = '000000000000000000000080';

async function withFixtureMongo<T>(work: (db: {
  collection: (name: string) => {
    findOne: (query: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    updateOne: (query: Record<string, unknown>, update: Record<string, unknown>, options?: Record<string, unknown>) => Promise<unknown>;
  };
}, id: (value: string) => unknown) => Promise<T>) {
  const root = process.env.GRIIPBUDDY_TEST_BACKEND_DIR;
  if (!root) throw new Error('Set GRIIPBUDDY_TEST_BACKEND_DIR to the local recovered backend with installed dependencies.');
  const { MongoClient, ObjectId } = createRequire(resolve(root, 'package.json'))('mongoose').mongo;
  const client = new MongoClient('mongodb://127.0.0.1:38117/griipbuddy_fixture?replicaSet=griip-recovery&directConnection=true', { serverSelectionTimeoutMS: 2000 });
  try {
    const db = client.db('griipbuddy_fixture');
    const topology = await db.admin().command({ hello: 1 });
    if (topology.setName !== 'griip-recovery' || topology.me !== '127.0.0.1:38117') throw new Error('Unexpected synthetic database topology.');
    if (!await db.collection('users').findOne({ _id: new ObjectId(ownerId), phone_number: '01000000002', role: 'USER' })) {
      throw new Error('Synthetic customer fixture not found.');
    }
    return await work(db, (value) => new ObjectId(value));
  } finally {
    await client.close();
  }
}

test('recovered login preserves the guest bag and serves only explicitly owned orders', async ({ page }) => {
  const password = process.env.GRIIPBUDDY_TEST_FIXTURE_PASSWORD;
  if (!password) throw new Error('Set GRIIPBUDDY_TEST_FIXTURE_PASSWORD to the password from the private recovery fixture.');
  await withFixtureMongo(async (db, id) => {
    await db.collection('orders').updateOne({ _id: id(wrongOwnerOrder) }, { $setOnInsert: {
      order_serial_id: 990128, invoice_number: 'FIXTURE-OTHER-990128', customer_phone: '01000000002',
      user: id('000000000000000000000010'), products: [], currency: 'BDT', total_amount: 555, status: 'DELIVERED',
    } }, { upsert: true });
  });
  await page.goto('/bd/product/fixture-bd');
  await page.getByRole('button', { name: 'Add to bag' }).click();
  await expect(page.getByRole('dialog', { name: 'Shopping bag' }).locator('.bag-estimate dd')).toContainText('880');
  await page.keyboard.press('Escape');
  await page.goto('/bd/login');
  await expect(page.getByRole('button', { name: 'Email', exact: true })).toBeDisabled();
  await page.getByLabel('Phone number').fill('01000000002');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/bd\/account$/);
  await expect(page.getByRole('link', { name: 'View shopping bag (1)' })).toBeVisible();

  const profile = await page.request.get('/api/account/me?userId=00000000000000000000000e');
  const scope = await profile.json();
  expect(scope).toMatchObject({ mode: 'recovered', customer: { id: ownerId, phone: '01000000002' } });
  expect(JSON.stringify(scope)).not.toMatch(/access_token|refresh_token|permissions|password/);
  const orders = await page.request.get('/api/account/orders');
  expect((await orders.json()).orders.map((order: { id: string }) => order.id)).toEqual([ownedOrder]);
  expect((await page.request.get('/bd/account/orders/' + wrongOwnerOrder)).status()).toBe(404);
  await page.getByRole('link', { name: 'Order 990001', exact: true }).click();
  await expect(page.getByText('FIXTURE-TRACKING')).toBeVisible();

  expect((await page.request.post('/api/account/profile', { data: { name: 'Denied', email: '' } })).status()).toBe(409);
  expect((await page.request.post('/api/account/recover', { data: { phone: '01000000002' } })).status()).toBe(409);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/bd\/login$/);
  expect((await page.request.get('/api/account/me')).status()).toBe(401);
  const staff = await page.request.post('/api/account/login', { data: { phone: '01000000001', password } });
  expect(staff.status()).toBe(401);
});

test('recovered registration and numeric OTP contract works with a new synthetic phone only', async ({ request }) => {
  const phone = '01999' + String(randomInt(100_000, 999_999));
  await withFixtureMongo(async (db) => expect(await db.collection('users').findOne({ phone_number: phone })).toBeNull());
  const registration = await request.post(api + '/user/register', { data: {
    full_name: 'Disposable OTP Fixture', phone_number: phone, password: 'Synthetic-Only-123',
  } });
  expect(registration.ok()).toBe(true);
  const otp = await withFixtureMongo(async (db) => (await db.collection('otp-records').findOne({ phone_number: phone }))?.otp);
  expect(typeof otp).toBe('number');
  const verify = (value: unknown) => request.patch(api + '/user/verify-otp', { data: { phone_number: phone, otp: value } });
  expect((await verify(-1)).ok()).toBe(false);
  expect((await verify(otp)).ok()).toBe(true);
  expect((await verify(otp)).ok()).toBe(false);
});
