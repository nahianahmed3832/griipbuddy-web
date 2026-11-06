import 'server-only';

import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { CartSnapshot } from '@/features/cart/cart';
import { AccountError, type Customer, type CustomerOrder } from './contracts';

const derive = promisify(scrypt);
const minute = 60_000;
const maxSessions = 500;
type Secret = { salt: string; hash: Buffer };
export type FixtureAccount = {
  profile: Customer;
  password: Secret;
  orders: CustomerOrder[];
  cart: CartSnapshot;
  transfers: Map<string, string>;
};
type Session = { mode: 'fixture' | 'recovered'; id: string; token?: string; expires: number };
type Purpose = 'register' | 'reset' | 'email';
type Challenge = {
  purpose: Purpose;
  id?: string;
  destination: string;
  registration?: { name: string; email: string; password: Secret };
  digest: Buffer;
  expires: number;
  remaining: number;
};
const globalState = globalThis as typeof globalThis & { griipAccountPreview?: ReturnType<typeof makeState> };

function makeState() {
  return {
    accounts: new Map<string, FixtureAccount>(),
    sessions: new Map<string, Session>(),
    challenges: new Map<string, Challenge>(),
    attempts: new Map<string, { count: number; until: number }>(),
    otpSecret: randomBytes(32),
    seed: undefined as Promise<void> | undefined,
  };
}

export const accountState = globalState.griipAccountPreview ??= makeState();

export async function hashPassword(password: string): Promise<Secret> {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: await derive(password, salt, 64) as Buffer };
}

const dummySalt = 'griipbuddy-preview-dummy-salt';
const dummyHash = Buffer.alloc(64);
export async function validPassword(password: string, stored?: Secret) {
  const hash = await derive(password, stored?.salt ?? dummySalt, 64) as Buffer;
  return timingSafeEqual(hash, stored?.hash ?? dummyHash) && Boolean(stored);
}

function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

export function startSession(session: Omit<Session, 'expires'>, upstreamExpiry?: number) {
  const now = Date.now();
  for (const [key, value] of accountState.sessions) if (value.expires <= now) accountState.sessions.delete(key);
  if (accountState.sessions.size >= maxSessions) throw new AccountError(503, 'Sign-in is temporarily unavailable.');
  const expires = Math.min(now + 30 * minute, upstreamExpiry ?? Infinity);
  if (expires <= now) throw new AccountError(401, 'Sign in again to continue.');
  const handle = randomBytes(32).toString('base64url');
  accountState.sessions.set(digest(handle), { ...session, expires });
  return { handle, expires };
}

export function readSession(handle?: string) {
  if (!handle || !/^[a-z0-9_-]{43}$/i.test(handle)) return undefined;
  const key = digest(handle);
  const session = accountState.sessions.get(key);
  if (session && session.expires <= Date.now()) {
    accountState.sessions.delete(key);
    return undefined;
  }
  return session;
}

export function endSession(handle?: string) {
  if (handle) accountState.sessions.delete(digest(handle));
}

export function endCustomerSessions(id: string) {
  for (const [key, session] of accountState.sessions) {
    if (session.mode === 'fixture' && session.id === id) accountState.sessions.delete(key);
  }
  for (const [key, challenge] of accountState.challenges) {
    if (challenge.id === id) accountState.challenges.delete(key);
  }
}

export function limitAttempt(key: string, max: number) {
  const now = Date.now();
  for (const [entry, value] of accountState.attempts) if (value.until <= now) accountState.attempts.delete(entry);
  const hash = digest(key);
  const current = accountState.attempts.get(hash) ?? { count: 0, until: now + 10 * minute };
  if (current.count >= max || (!accountState.attempts.has(hash) && accountState.attempts.size >= 5000)) {
    throw new AccountError(429, 'Too many attempts. Try again in a few minutes.');
  }
  current.count++;
  accountState.attempts.set(hash, current);
}

function otpDigest(handle: string, code: string) {
  return createHmac('sha256', accountState.otpSecret).update(handle + ':' + code).digest();
}

export function makeChallenge(purpose: Purpose, destination: string, id?: string, registration?: Challenge['registration']) {
  const now = Date.now();
  for (const [key, value] of accountState.challenges) if (value.expires <= now) accountState.challenges.delete(key);
  if (accountState.challenges.size >= 500) throw new AccountError(503, 'Verification is temporarily unavailable.');
  const handle = randomBytes(32).toString('base64url');
  const code = String(randomInt(100_000, 1_000_000));
  accountState.challenges.set(handle, { purpose, id, destination, registration, digest: otpDigest(handle, code), expires: now + 5 * minute, remaining: 5 });
  return { handle, code };
}

export function checkChallenge(handle: string | undefined, purpose: Purpose, code: string) {
  const challenge = handle ? accountState.challenges.get(handle) : undefined;
  if (!handle || !challenge || challenge.purpose !== purpose || challenge.expires <= Date.now() || challenge.remaining <= 0) {
    throw new AccountError(400, 'This code is invalid or expired. Request a new code.');
  }
  challenge.remaining--;
  if (!/^\d{6}$/.test(code) || !timingSafeEqual(challenge.digest, otpDigest(handle, code))) {
    if (!challenge.remaining) accountState.challenges.delete(handle);
    throw new AccountError(400, 'This code is invalid or expired. Check the code and try again.');
  }
  accountState.challenges.delete(handle);
  return challenge;
}
