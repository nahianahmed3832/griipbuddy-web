import type { CartSnapshot } from '@/features/cart/cart';

export type Address = {
  id: string;
  label: string;
  street: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
};

export type Preferences = { orderEmail: boolean; marketingEmail: boolean; marketingSms: boolean };
export type ReturnRequest = { id: string; orderId: string; kind: 'return' | 'refund'; reason: string; createdAt: string };
export type Customer = {
  id: string;
  name: string;
  phone: string;
  email: string;
  emailVerified: boolean;
  addresses: Address[];
  defaultAddress?: string;
  saved: string[];
  preferences?: Preferences;
  returns: ReturnRequest[];
};

export type CustomerOrder = {
  syntheticCheckout?: boolean;
  id: string;
  number: string;
  status: string;
  currency?: string;
  total?: number;
  date?: string;
  tracking?: string;
  lines: { name: string; sku?: string; quantity: number }[];
  history: { status: string; date?: string }[];
};

export type AccountScope = {
  customer: Customer;
  mode: 'fixture' | 'recovered';
  cart?: CartSnapshot;
};

export type CartCommand =
  | { type: 'add'; line: unknown }
  | { type: 'quantity'; key: string; quantity: number }
  | { type: 'adjust'; key: string; delta: number }
  | { type: 'remove'; key: string }
  | { type: 'coupon'; market: string; code?: string };

export class AccountError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function fields(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function text(value: unknown, max: number) {
  return typeof value === 'string' && value.trim().length <= max ? value.trim() : '';
}

export function phoneNumber(value: unknown) {
  const input = text(value, 30).replace(/[ ().-]/g, '');
  return /^(?:\+[1-9]\d{7,14}|\d{10,15})$/.test(input) ? input : '';
}

export function phoneKey(phone: string) {
  return /^(?:\+880|880)1\d{9}$/.test(phone) ? '0' + phone.slice(-10) : phone;
}

export function emailAddress(value: unknown) {
  const address = text(value, 254).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address) ? address : '';
}

export function passwordValue(value: unknown, minimum = 12) {
  return typeof value === 'string' && value.length >= minimum && value.length <= 128 ? value : '';
}

export function accountId(value: unknown) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,90}$/i.test(value);
}

export function orderStatus(value: string) {
  return value ? value.toLowerCase().replace(/_/g, ' ').replace(/^./, (letter) => letter.toUpperCase()) : 'Status unavailable';
}
