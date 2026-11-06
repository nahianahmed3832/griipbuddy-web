import 'server-only';

import { apiConfigured, objectId } from '@/features/catalog/api';
import { AccountError, fields, text, type Address, type Customer, type CustomerOrder } from './contracts';

function ref(value: unknown) {
  return typeof value === 'string' ? value : text(fields(value)._id, 90);
}

const paths = { login: '/user/login', profile: '/user', orders: '/order/customer/my-order' };

async function recovered(action: keyof typeof paths, { token, page, body }: { token?: string; page?: number; body?: unknown }) {
  const base = process.env.GRIIPBUDDY_CATALOG_API ?? '';
  if (!apiConfigured() || !/^http:\/\/127\.0\.0\.1:\d{4,5}\/api\/v1$/.test(base)) {
    throw new AccountError(503, 'The isolated customer API is unavailable.');
  }
  const response = await fetch(base + paths[action] + (page ? '?limit=50&page=' + page : ''), {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000), cache: 'no-store', redirect: 'error',
  }).catch(() => { throw new AccountError(503, 'The isolated customer API is unavailable.'); });
  if ([400, 401, 403, 404].includes(response.status)) {
    throw new AccountError(401, action === 'login' ? 'Check your phone number and password.' : 'Sign in again to continue.');
  }
  const envelope = fields(await response.json().catch(() => null));
  if (!response.ok || envelope.success !== true) throw new AccountError(503, 'The isolated customer API is unavailable.');
  return fields(envelope.data);
}

function address(value: unknown, id: string, label: string): Address | undefined {
  const row = fields(value);
  const street = text(row.local_address, 200);
  if (!street) return undefined;
  return { id, label, street, city: text(row.district, 80), region: text(row.division, 80), postalCode: '', country: 'BD' };
}

export async function recoveredCustomer(token: string): Promise<Customer> {
  const row = await recovered('profile', { token });
  const id = ref(row);
  if (!objectId(id) || row.role !== 'USER' || row.is_verified_number !== true || row.status !== 'ACTIVE' || row.isDeleted === true) {
    throw new AccountError(401, 'Use an active customer account with a verified phone.');
  }
  const addresses = [
    address(row.default_delivery_address, 'default', 'Default delivery'),
    address(row.address, 'account', 'Account address'),
    address(row.permanent_address, 'permanent', 'Permanent address'),
  ].flatMap((item) => item ?? []);
  return {
    id, name: text(row.full_name, 120), phone: text(row.phone_number, 30), email: text(row.email, 254),
    emailVerified: false, addresses, defaultAddress: addresses.some((item) => item.id === 'default') ? 'default' : undefined,
    saved: Array.isArray(row.favorite_items) ? row.favorite_items.flatMap((item) => text(fields(item).slug, 180) || []) : [],
    returns: [],
  };
}

export async function recoveredLogin(phone: string, password: string) {
  const result = await recovered('login', { body: { phone_number: phone, password } });
  const token = text(result.access_token, 8000);
  if (!token) throw new AccountError(401, 'Sign in again to continue.');
  const profile = await recoveredCustomer(token);
  let expiry: unknown;
  try { expiry = fields(JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())).exp; }
  catch { throw new AccountError(401, 'Sign in again to continue.'); }
  if (typeof expiry !== 'number' || !Number.isFinite(expiry)) throw new AccountError(401, 'Sign in again to continue.');
  return { profile, token, expires: expiry * 1000 };
}

function normalizeOrder(value: unknown, owner: string): CustomerOrder | undefined {
  const row = fields(value);
  const id = ref(row);
  // The recovered list queries by phone. An explicit customer reference is required here.
  if (!objectId(id) || ref(row.user) !== owner) return undefined;
  const currency = text(row.currency, 3);
  const number = text(row.invoice_number, 90) || (Number.isSafeInteger(row.order_serial_id) ? String(row.order_serial_id) : '');
  return {
    id, number: number || id,
    status: text(row.status, 50),
    currency: /^[A-Z]{3}$/.test(currency) ? currency : undefined,
    total: typeof row.total_amount === 'number' && Number.isFinite(row.total_amount) && row.total_amount >= 0 ? row.total_amount : undefined,
    date: text(row.createdAt, 40) || undefined, tracking: text(row.tracking_code, 100) || undefined,
    lines: Array.isArray(row.products) ? row.products.flatMap((value) => {
      const item = fields(value);
      if (typeof item.total_quantity !== 'number' || !Number.isSafeInteger(item.total_quantity) || item.total_quantity < 1) return [];
      const name = text(fields(item.product).name, 180) || text(item.name, 180) || 'Product';
      return [{ name, sku: text(fields(item.selected_variant).sku, 120) || undefined, quantity: item.total_quantity }];
    }) : [],
    history: Array.isArray(row.status_history) ? row.status_history.flatMap((value) => {
      const item = fields(value);
      const status = text(item.status, 50);
      return status ? [{ status, date: text(item.changed_at, 40) || undefined }] : [];
    }) : [],
  };
}

export async function recoveredOrders(token: string, owner: string) {
  const first = await recovered('orders', { token, page: 1 });
  const total = fields(first.meta).total;
  const pages = typeof total === 'number' && Number.isFinite(total) ? Math.min(6, Math.max(1, Math.ceil(total / 50))) : 1;
  const rest = await Promise.all(Array.from({ length: pages - 1 }, (_, index) => recovered('orders', { token, page: index + 2 })));
  const orders = [first, ...rest].flatMap((page) => Array.isArray(page.data) ? page.data.flatMap((item) => normalizeOrder(item, owner) ?? []) : []);
  return [...new Map(orders.map((order) => [order.id, order])).values()];
}
