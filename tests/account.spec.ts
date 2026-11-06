import { randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const password = 'Preview-New-Pass-123';
const testPhone = () => '01000' + String(randomInt(100_000, 999_999));

async function login(page: Page, identifier: string, secret = password, email = false, market = 'us') {
  await page.goto('/' + market + '/login');
  if (email) await page.getByRole('button', { name: 'Email', exact: true }).click();
  await page.getByLabel(email ? 'Email address' : 'Phone number', { exact: true }).fill(identifier);
  await page.getByLabel('Password', { exact: true }).fill(secret);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(new RegExp('/' + market + '/account$'));
}

async function startRegistration(page: Page, phone: string, name: string, email?: string) {
  await page.goto('/us/account/register');
  await page.getByLabel('Full name').fill(name);
  if (email) await page.getByLabel('Email address (optional)').fill(email);
  await page.getByLabel('Phone number').fill(phone);
  await page.getByLabel('New password').fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Send verification code' }).click();
  await expect(page.getByRole('heading', { name: 'Verify your phone' })).toBeVisible();
  return (await page.getByLabel('Preview SMS code').innerText()).trim();
}

async function verifyRegistration(page: Page, code: string) {
  await page.getByLabel('Verification code').fill(code);
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(page).toHaveURL(/\/us\/account$/);
}

async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
}

test('guest bag transfers once after OTP registration and stays private after logout', async ({ page, request, context }) => {
  const phone = testPhone();
  await page.goto('/us/login');
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeDisabled();
  await page.goto('/us/product/form-case');
  await page.getByRole('button', { name: 'Add to bag' }).click();
  await expect(page.getByRole('dialog', { name: 'Shopping bag' }).locator('.bag-estimate dd')).toHaveText('$41');
  await page.keyboard.press('Escape');

  const guest = await page.evaluate(() => JSON.parse(window.localStorage.getItem('griipbuddy-cart-v1') ?? '{}'));
  const code = await startRegistration(page, phone, 'Riley Preview');
  expect((await page.request.get('/api/account/me')).status()).toBe(401);
  await page.getByLabel('Verification code').fill(code === '000000' ? '999999' : '000000');
  await page.getByRole('button', { name: 'Verify and continue' }).click();
  await expect(page.locator('.account-feedback[role=alert]')).toContainText('invalid or expired');
  await verifyRegistration(page, code);
  await expect(page.getByRole('heading', { name: 'Hello, Riley' })).toBeVisible();
  await expect(page.getByText('Your guest bag was added to your account.')).toBeVisible();
  const replay = await page.request.post('/api/account/login', { data: { phone, password, guest } });
  expect(await replay.json()).toMatchObject({ signedIn: true, transferred: true });
  await page.getByRole('link', { name: 'View shopping bag (1)' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Quantity for The Form Case' })).toHaveValue('1');

  await page.getByRole('button', { name: 'Increase quantity for The Form Case' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Quantity for The Form Case' })).toHaveValue('2');
  await page.reload();
  await expect(page.getByRole('spinbutton', { name: 'Quantity for The Form Case' })).toHaveValue('2');
  const issued = (await context.cookies()).find((cookie) => cookie.name === 'griipbuddy-customer');
  expect(issued?.httpOnly).toBe(true);
  expect(issued?.sameSite).toBe('Lax');

  await page.goto('/gb/account');
  await expect(page.getByText('United Kingdom · GBP', { exact: true }).first()).toBeVisible();
  await page.getByRole('link', { name: 'View shopping bag (2)' }).click();
  await expect(page.getByText('£28 each', { exact: true })).toBeVisible();
  await page.goto('/gb/account');
  await signOut(page);
  expect((await request.get('/api/account/me', { headers: { cookie: 'griipbuddy-customer=' + issued?.value } })).status()).toBe(401);
  await page.goBack();
  await expect(page).toHaveURL(/\/gb\/login$/);
  await page.goto('/gb/cart');
  await expect(page.getByRole('heading', { name: 'Your bag is empty' })).toBeVisible();
  await login(page, phone);
  await expect(page.getByRole('link', { name: 'View shopping bag (2)' })).toBeVisible();
});

test('customer edits profile, default addresses and preferences and can sign in by verified email', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const phone = testPhone();
  const email = 'customer-' + phone + '@preview.invalid';
  await verifyRegistration(page, await startRegistration(page, phone, 'Dev Customer'));
  const nav = page.getByRole('navigation', { name: 'Account navigation' });
  await nav.getByRole('link', { name: 'Personal information' }).click();
  await page.getByLabel('Full name').fill('Dev Edited');
  await page.getByLabel('Email address').fill(email);
  await page.getByRole('button', { name: 'Save personal information' }).click();
  await expect(page.getByText('Personal information saved.')).toBeVisible();

  await nav.getByRole('link', { name: 'Saved addresses' }).click();
  for (const label of ['Home', 'Work']) {
    await page.getByLabel('Address label').fill(label);
    await page.getByLabel('Street address').fill(label + ' Sample Lane');
    await page.getByLabel('City', { exact: true }).fill('Dhaka');
    await page.getByLabel('Country code').fill('BD');
    await page.getByRole('button', { name: 'Save address' }).click();
    await expect(page.getByRole('heading', { name: label, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Set Work as default' }).click();
  await expect(page.locator('.account-address').filter({ has: page.getByRole('heading', { name: 'Work', exact: true }) }).getByText('Default')).toBeVisible();

  await nav.getByRole('link', { name: 'Notifications' }).click();
  await page.getByLabel('Offers by email').check();
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await expect(page.getByText('Notification preferences saved.')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Offers by email')).toBeChecked();

  await nav.getByRole('link', { name: 'Security' }).click();
  expect((await page.request.post('/api/account/login', { data: { email, password } })).status()).toBe(401);
  await page.getByRole('button', { name: 'Send email verification code' }).click();
  const code = (await page.getByLabel('Preview email code').innerText()).trim();
  await page.getByLabel('Verification code').fill(code);
  await page.getByRole('button', { name: 'Verify email' }).click();
  await expect(page.getByText(email + ' · Verified')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  await signOut(page);
  await login(page, email, password, true);
  await expect(page.getByText('Dev Edited', { exact: true })).toBeVisible();
});

test('purpose-bound password recovery revokes sessions and rejects replay', async ({ page, browser, request, context }) => {
  const phone = testPhone();
  await verifyRegistration(page, await startRegistration(page, phone, 'Recovery Preview'));
  const old = (await context.cookies()).find((cookie) => cookie.name === 'griipbuddy-customer')?.value;
  const second = await browser.newPage();
  const base = new URL(page.url()).origin;
  await second.goto(base + '/us/account/recover');
  await second.getByLabel('Phone number').fill(phone);
  await second.getByRole('button', { name: 'Send reset code' }).click();
  const code = (await second.getByLabel('Preview SMS code').innerText()).trim();
  expect((await second.request.post(base + '/api/account/verify', { data: { code } })).status()).toBe(400);
  await second.getByLabel('Verification code').fill(code);
  const replacement = 'Preview-Replaced-456';
  await second.getByLabel('New password').fill(replacement);
  await second.getByLabel('Confirm password').fill(replacement);
  await second.getByRole('button', { name: 'Reset password' }).click();
  await expect(second.getByText('Password updated. Sign in with your new password.')).toBeVisible();
  expect((await request.get('/api/account/me', { headers: { cookie: 'griipbuddy-customer=' + old } })).status()).toBe(401);
  expect((await second.request.post(base + '/api/account/reset', { data: { code, password: replacement, confirm: replacement } })).status()).toBe(400);
  expect((await second.request.post(base + '/api/account/login', { data: { phone, password } })).status()).toBe(401);
  await page.goto('/us/login');
  await login(page, phone, replacement);
  await page.goto('/us/account/security');
  await page.getByLabel('Current password').fill(replacement);
  await page.getByLabel('New password').fill(password);
  await page.getByLabel('Confirm password').fill(password);
  await page.getByRole('button', { name: 'Change password and sign out' }).click();
  await expect(page).toHaveURL(/\/us\/login$/);
  await login(page, phone);
  await second.close();
});

test('orders, saved items and return requests stay scoped to the customer', async ({ page, request }) => {
  expect((await request.get('/api/account/orders')).status()).toBe(401);
  expect((await request.post('/api/account/profile', { data: { name: 'Denied', email: '' } })).status()).toBe(401);
  await login(page, '01000000021', 'Preview-only-2026');
  await page.getByRole('link', { name: 'Order GB-1842', exact: true }).click();
  await expect(page.getByText('DEMO-TRACK-1842')).toBeVisible();
  await expect(page.getByText('The Arc Shoulder Bag', { exact: true })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Account navigation' });
  await nav.getByRole('link', { name: 'Wishlist' }).click();
  await expect(page.getByRole('heading', { name: 'Studio Frames' })).toBeVisible();
  await nav.getByRole('link', { name: 'Returns & refunds' }).click();
  await expect(page).toHaveURL(/\/account\/returns$/);
  await page.getByRole('combobox', { name: 'Order', exact: true }).selectOption('demo-order-1764');
  await page.getByRole('combobox', { name: 'Request type', exact: true }).selectOption('refund');
  await page.getByLabel('Reason').fill('Synthetic return request for browser verification.');
  await page.getByRole('button', { name: 'Submit request' }).click();
  await expect(page.getByText('Refund request', { exact: true })).toBeVisible();
  await signOut(page);

  await verifyRegistration(page, await startRegistration(page, testPhone(), 'Other Preview'));
  expect((await page.request.get('/us/account/orders/demo-order-1842')).status()).toBe(404);
  expect((await page.request.post('/api/account/address', { data: { operation: 'remove', id: 'demo-home' } })).status()).toBe(404);
  expect((await page.request.post('/api/account/return', { data: { orderId: 'demo-order-1764', kind: 'refund', reason: 'Denied' } })).status()).toBe(404);
  const own = await page.request.get('/api/account/me?customerId=preview-customer-maya');
  expect((await own.json()).customer).toMatchObject({ name: 'Other Preview', addresses: [], saved: [] });
  expect((await page.request.post('/api/account/profile', { headers: { origin: 'https://other.invalid' }, data: { name: 'Denied' } })).status()).toBe(403);
});
