import 'server-only';

import { randomUUID } from 'node:crypto';
import { hostedCatalogPreview } from '@/features/public-build';
import { AccountError, phoneKey, type Customer, type CustomerOrder } from './contracts';
import { accountState, hashPassword, type FixtureAccount } from './state';

const sampleOrders: CustomerOrder[] = [
  {
    id: 'demo-order-1842', number: 'GB-1842', status: 'IN_TRANSIT', currency: 'USD', total: 93, date: '2026-11-03T08:00:00Z',
    tracking: 'DEMO-TRACK-1842', lines: [{ name: 'The Arc Shoulder Bag', sku: 'DEMO-ARC-BAG-ESPRESSO', quantity: 1 }],
    history: [{ status: 'PLACED', date: '2026-11-03T08:00:00Z' }, { status: 'IN_TRANSIT', date: '2026-11-05T12:30:00Z' }],
  },
  {
    id: 'demo-order-1764', number: 'GB-1764', status: 'DELIVERED', currency: 'USD', total: 41, date: '2026-10-15T09:00:00Z',
    tracking: 'DEMO-TRACK-1764', lines: [{ name: 'The Form Case', sku: 'DEMO-FORM-CASE-STD', quantity: 1 }],
    history: [{ status: 'PLACED', date: '2026-10-15T09:00:00Z' }, { status: 'DELIVERED', date: '2026-10-18T13:00:00Z' }],
  },
];

function fixtureAccount(name: string, phone: string, email: string, password: FixtureAccount['password'], id: string = randomUUID()): FixtureAccount {
  const profile: Customer = {
    id, name, phone: phoneKey(phone), email, emailVerified: false,
    addresses: [], saved: [], returns: [], preferences: { orderEmail: true, marketingEmail: false, marketingSms: false },
  };
  return { profile, password, orders: [], cart: { version: 1, lines: [] }, transfers: new Map() };
}

export async function seedAccounts() {
  if (hostedCatalogPreview()) return;
  accountState.seed ??= (async () => {
    const password = await hashPassword('Preview-only-2026');
    const account = fixtureAccount('Maya Rahman', '01000000021', 'maya@preview.invalid', password, 'preview-customer-maya');
    account.profile.addresses = [{ id: 'demo-home', label: 'Home', street: '24 Sample Lane', city: 'Dhaka', region: 'Dhaka', postalCode: '1205', country: 'BD' }];
    account.profile.defaultAddress = 'demo-home';
    account.profile.emailVerified = true;
    account.profile.saved = ['arc-bag', 'studio-frames'];
    account.orders = sampleOrders;
    accountState.accounts.set(account.profile.id, account);
  })();
  await accountState.seed;
}

export async function findFixturePhone(phone: string) {
  await seedAccounts();
  return [...accountState.accounts.values()].find((account) => account.profile.phone === phoneKey(phone));
}

export async function findVerifiedFixtureEmail(email: string) {
  await seedAccounts();
  return [...accountState.accounts.values()].find((account) => account.profile.emailVerified && account.profile.email === email);
}

export async function addFixtureAccount(name: string, phone: string, email: string, secret: FixtureAccount['password']) {
  await seedAccounts();
  if ([...accountState.accounts.values()].some((account) => account.profile.phone === phoneKey(phone))) throw new AccountError(409, 'This phone is already registered. Sign in or request help.');
  if (accountState.accounts.size >= 300) throw new AccountError(503, 'Registration is temporarily unavailable.');
  const account = fixtureAccount(name, phone, email, secret);
  accountState.accounts.set(account.profile.id, account);
  return account;
}
