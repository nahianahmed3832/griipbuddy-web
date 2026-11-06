import 'server-only';

import { createHash } from 'node:crypto';
import { lineKey, maxCartLines, mergeCartLines, parseCoupon, parseLine } from '@/features/cart/cart';
import { AccountError, fields } from './contracts';
import type { FixtureAccount } from './state';

function coupon(value: unknown) {
  const input = fields(value);
  const code = parseCoupon(input.code);
  return code && typeof input.market === 'string' && /^(?:[A-Z]{2}|INTL)$/.test(input.market)
    ? { market: input.market, code } : undefined;
}

export function transferGuestCart(account: FixtureAccount, value: unknown) {
  const input = fields(value);
  if (!Array.isArray(input.lines) || !input.lines.length) return { transferred: false };
  const id = input.transferId;
  const invalid = { transferred: false, message: 'Your guest bag is still saved on this device.' };
  if (typeof id !== 'string' || !/^[a-f\d-]{36}$/i.test(id) || input.lines.length > maxCartLines) return invalid;
  const lines = input.lines.flatMap((line) => parseLine(line) ?? []);
  if (lines.length !== input.lines.length || new Set(lines.map(lineKey)).size !== lines.length) return invalid;
  const discount = coupon(input.coupon);
  const fingerprint = createHash('sha256').update(JSON.stringify({ lines, discount })).digest('hex');
  const previous = account.transfers.get(id);
  if (previous) return previous === fingerprint ? { transferred: true } : invalid;
  if (account.transfers.size >= 100) return invalid;

  const merged = mergeCartLines(account.cart.lines, lines);
  if (!merged) return { transferred: false, message: 'The combined bag exceeds its limits. Your guest bag is still saved on this device.' };
  account.cart = { version: 1, lines: merged, coupon: account.cart.coupon ?? discount };
  account.transfers.set(id, fingerprint);
  return { transferred: true };
}

export function changeAccountCart(account: FixtureAccount, value: unknown) {
  const command = fields(value);
  const current = account.cart;
  if (command.type === 'add') {
    const line = parseLine(command.line);
    const lines = line ? mergeCartLines(current.lines, [line]) : undefined;
    if (!lines) throw new AccountError(400, 'Check the item and your bag limits.');
    account.cart = { ...current, lines };
  } else if (command.type === 'remove') {
    account.cart = { ...current, lines: current.lines.filter((line) => lineKey(line) !== command.key) };
  } else if (command.type === 'quantity' || command.type === 'adjust') {
    const line = current.lines.find((item) => lineKey(item) === command.key);
    const amount = command.type === 'quantity' ? command.quantity
      : typeof command.delta === 'number' && Math.abs(command.delta) === 1 && line ? line.quantity + command.delta : undefined;
    const next = line ? parseLine({ ...line, quantity: amount }) : undefined;
    if (!next) throw new AccountError(400, 'Enter a valid quantity.');
    account.cart = { ...current, lines: current.lines.map((item) => lineKey(item) === command.key ? next : item) };
  } else if (command.type === 'coupon') {
    const discount = command.code === undefined ? undefined : coupon(command);
    if (command.code !== undefined && !discount) throw new AccountError(400, 'Enter a valid coupon code.');
    account.cart = { ...current, coupon: discount };
  } else throw new AccountError(400, 'Invalid bag action.');
  return account.cart;
}
