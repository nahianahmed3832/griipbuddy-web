import 'server-only';

import { randomUUID } from 'node:crypto';
import { cookies } from 'next/headers';
import { hostedCatalogPreview } from '@/features/public-build';
import { validSlug } from '@/features/catalog/catalog';
import { accountMode } from './config';
import { AccountError, emailAddress, passwordValue, phoneKey, phoneNumber, text, type Address } from './contracts';
import { addFixtureAccount, findFixturePhone, findVerifiedFixtureEmail } from './fixture';
import { recoveredFavorite, recoveredLogin, recoveredRegister, recoveredVerify, recoveredWishlistEnabled } from './recovered';
import { challengeCookie, clearSession, requireCustomer, setChallenge, setSession } from './session';
import { accountState, checkChallenge, endCustomerSessions, hashPassword, limitAttempt, makeChallenge, validPassword, type FixtureAccount } from './state';
import { changeAccountCart, transferGuestCart } from './customer-cart';

function unavailable() {
  return new AccountError(409, 'This change is unavailable for recovered accounts. Contact support for help.');
}

function requireTestPhone(phone: string) {
  if (!/^0000000\d{4}$/.test(phoneKey(phone))) {
    throw new AccountError(400, 'Use a test phone number starting with 0000000, followed by four digits.');
  }
}

function requireTestEmail(email: string) {
  if (!email.endsWith('@preview.invalid')) {
    throw new AccountError(400, 'Use a test email ending in @preview.invalid.');
  }
}

async function login(request: Request, body: Record<string, unknown>) {
  const phone = phoneNumber(body.phone);
  const email = emailAddress(body.email);
  const password = passwordValue(body.password, 1);
  if ((!phone && !email) || (phone && email) || !password) throw new AccountError(400, 'Enter your phone number or email and your password.');
  const preview = hostedCatalogPreview();
  if (preview) {
    if (email) requireTestEmail(email);
    else requireTestPhone(phone);
  }
  const recoveredAccount = accountMode() === 'recovered';
  if (email && recoveredAccount) throw new AccountError(409, 'Use your verified phone to sign in to a recovered account.');
  limitAttempt('login:' + (email || phoneKey(phone)), 8);
  limitAttempt('login:all', 120);
  if (recoveredAccount) {
    const recovered = await recoveredLogin(phone, password).catch((error) => {
      if (error instanceof AccountError && error.status === 401 && phoneKey(phone) !== phone) return recoveredLogin(phoneKey(phone), password);
      throw error;
    });
    await setSession(request, { mode: 'recovered', id: recovered.profile.id, token: recovered.token }, recovered.expires);
    return { signedIn: true, transferred: false };
  }
  const account = email ? await findVerifiedFixtureEmail(email) : await findFixturePhone(phone);
  if (!await validPassword(password, account?.password) || !account) {
    throw new AccountError(401, email ? 'Check your verified email and password.' : 'Check your phone number and password.');
  }
  await setSession(request, { mode: 'fixture', id: account.profile.id });
  return { signedIn: true, ...(preview ? { transferred: false } : transferGuestCart(account, body.guest)) };
}

async function fixtureChallenge(request: Request, purpose: Parameters<typeof makeChallenge>[0], destination: string, id?: string,
  registration?: Parameters<typeof makeChallenge>[3]) {
  const challenge = makeChallenge(purpose, destination, id, registration);
  await setChallenge(request, challenge.handle);
  // Only the synthetic fixture mode can issue a code or return one to the test inbox.
  return { next: purpose === 'register' ? 'verify' : purpose === 'reset' ? 'reset' : 'email-verify', previewCode: challenge.code };
}

async function verifyChallenge(purpose: Parameters<typeof checkChallenge>[1], code: unknown) {
  return checkChallenge((await cookies()).get(challengeCookie)?.value, purpose, text(code, 6));
}

function validateNewPassword(body: Record<string, unknown>) {
  const password = passwordValue(body.password);
  if (!password || password !== body.confirm) throw new AccountError(400, 'Use at least 12 characters and make sure both passwords match.');
  return password;
}

function updateProfile(account: FixtureAccount, body: Record<string, unknown>) {
  const name = text(body.name, 120);
  const email = emailAddress(body.email);
  if (!name || (body.email !== '' && !email)) throw new AccountError(400, 'Enter your name and a valid email address or leave email blank.');
  if (email !== account.profile.email) account.profile.emailVerified = false;
  account.profile.name = name;
  account.profile.email = email;
}

function changeAddress(account: FixtureAccount, body: Record<string, unknown>) {
  const profile = account.profile;
  const id = text(body.id, 90);
  const existing = profile.addresses.find((address) => address.id === id);
  if (body.operation === 'default' || body.operation === 'remove') {
    if (!existing) throw new AccountError(404, 'Address not found.');
    if (body.operation === 'default') profile.defaultAddress = id;
    else {
      profile.addresses = profile.addresses.filter((address) => address.id !== id);
      if (profile.defaultAddress === id) profile.defaultAddress = profile.addresses[0]?.id;
    }
    return;
  }
  if (body.operation !== 'save' || (id && !existing)) throw new AccountError(404, 'Address not found.');
  if (!existing && profile.addresses.length >= 10) throw new AccountError(400, 'You can save up to ten addresses.');
  const address: Address = {
    id: existing?.id ?? randomUUID(), label: text(body.label, 50), street: text(body.street, 200), city: text(body.city, 80),
    region: text(body.region, 80), postalCode: text(body.postalCode, 20), country: text(body.country, 2).toUpperCase(),
  };
  if (!address.label || !address.street || !address.city || !/^[A-Z]{2}$/.test(address.country)) {
    throw new AccountError(400, 'Enter a label, street, city and two-letter country code.');
  }
  profile.addresses = existing ? profile.addresses.map((item) => item.id === id ? address : item) : [...profile.addresses, address];
  if (!profile.defaultAddress) profile.defaultAddress = address.id;
}

function requestReturn(account: FixtureAccount, body: Record<string, unknown>) {
  const order = account.orders.find((item) => item.id === body.orderId);
  if (!order) throw new AccountError(404, 'Order not found.');
  const reason = text(body.reason, 500);
  const kind = body.kind;
  if (order.status !== 'DELIVERED' || (kind !== 'return' && kind !== 'refund') || !reason) {
    throw new AccountError(400, 'Select a delivered order and tell us why you are making this request.');
  }
  if (account.profile.returns.some((item) => item.orderId === order.id)) throw new AccountError(409, 'A request already exists for this order.');
  account.profile.returns.push({ id: randomUUID(), orderId: order.id, kind, reason, createdAt: new Date().toISOString() });
}

export async function accountAction(request: Request, action: string, body: Record<string, unknown>) {
  if (action === 'login') return login(request, body);
  if (action === 'logout') {
    await clearSession(request);
    return { signedOut: true };
  }

  if (action === 'register' || action === 'verify' || action === 'recover' || action === 'reset') {
    if (accountMode() === 'recovered') {
      if (process.env.GRIIPBUDDY_CHECKOUT !== 'integrated' || !['register','verify'].includes(action)) throw unavailable();
      const phone = phoneNumber(body.phone);
      if (!phone || !/^\d{10,15}$/.test(phoneKey(phone))) throw new AccountError(400, 'Enter a valid phone number.');
      const local = phoneKey(phone);
      limitAttempt(action + ':' + local, action === 'register' ? 4 : 8);
      limitAttempt(action + ':all', 80);
      if (action === 'register') {
        const name = text(body.name, 120);
        if (!name) throw new AccountError(400, 'Enter your name.');
        await recoveredRegister(local, name, validateNewPassword(body));
        return { next:'verify' };
      }
      const code = text(body.code, 5);
      if (!/^\d{5}$/.test(code)) throw new AccountError(400, 'Enter the five-digit verification code.');
      const account = await recoveredVerify(local, Number(code));
      await setSession(request, { mode:'recovered', id:account.profile.id, token:account.token }, account.expires);
      return { signedIn:true, transferred:false };
    }
    if (action === 'register') {
      const phone = phoneNumber(body.phone);
      const name = text(body.name, 120);
      const preview = hostedCatalogPreview();
      const email = emailAddress(body.email);
      const password = validateNewPassword(body);
      if ((!phone && (!preview || !email)) || !name || (body.email !== undefined && body.email !== '' && !email)) {
        throw new AccountError(400, preview ? 'Enter a test name and either a test phone or test email.'
          : 'Enter a name, phone number and a valid email address if supplied.');
      }
      if (preview) {
        if (phone || body.phone) requireTestPhone(phone);
        if (email) requireTestEmail(email);
      }
      limitAttempt('register:' + (phoneKey(phone) || email), 4);
      limitAttempt('register:all', 80);
      if (phone && await findFixturePhone(phone)) throw new AccountError(409, 'This phone is already registered. Sign in or request help.');
      if (preview && email && await findVerifiedFixtureEmail(email)) throw new AccountError(409, 'This email is already registered. Sign in instead.');
      return fixtureChallenge(request, 'register', phone || email, undefined, { name, phone, email, password: await hashPassword(password) });
    }
    if (action === 'verify') {
      const challenge = await verifyChallenge('register', body.code);
      if (!challenge.registration) throw new AccountError(400, 'Start registration again.');
      const { name, phone, email, password } = challenge.registration;
      const account = await addFixtureAccount(name, phone, email, password, hostedCatalogPreview());
      await setSession(request, { mode: 'fixture', id: account.profile.id });
      return { signedIn: true, ...(hostedCatalogPreview() ? { transferred: false } : transferGuestCart(account, body.guest)) };
    }
    if (action === 'recover') {
      const phone = phoneNumber(body.phone);
      if (!phone) throw new AccountError(400, 'Enter a valid phone number.');
      limitAttempt('recover:' + phoneKey(phone), 4);
      limitAttempt('recover:all', 80);
      return fixtureChallenge(request, 'reset', phone, (await findFixturePhone(phone))?.profile.id);
    }
    const password = validateNewPassword(body);
    const challenge = await verifyChallenge('reset', body.code);
    const account = challenge.id ? accountState.accounts.get(challenge.id) : undefined;
    if (!account) throw new AccountError(400, 'This code is invalid or expired. Request a new code.');
    const old = account.password;
    const secret = await hashPassword(password);
    if (account.password !== old) throw new AccountError(409, 'This password was changed. Request a new code.');
    account.password = secret;
    endCustomerSessions(account.profile.id);
    await clearSession(request);
    return { reset: true };
  }

  const scope = await requireCustomer();
  if (action === 'wishlist' && scope.mode === 'recovered' && recoveredWishlistEnabled()) {
    const slug = text(body.slug, 180);
    if (!validSlug(slug) || typeof body.saved !== 'boolean') throw new AccountError(400, 'Choose a product and wishlist action.');
    return recoveredFavorite(scope.token, slug, body.saved);
  }
  if (!scope.fixture) throw unavailable();
  const account = scope.fixture;
  if (action === 'cart') return { cart: changeAccountCart(account, body) };
  if (action === 'wishlist') {
    const slug = text(body.slug, 180);
    if (!validSlug(slug)) throw new AccountError(400, 'Invalid product.');
    const saved = account.profile.saved;
    if (!saved.includes(slug) && saved.length >= 100) throw new AccountError(400, 'Your wishlist is full.');
    account.profile.saved = saved.includes(slug) ? saved.filter((item) => item !== slug) : [...saved, slug];
    return { saved: account.profile.saved };
  }
  if (action === 'profile') updateProfile(account, body);
  else if (action === 'address') changeAddress(account, body);
  else if (action === 'return') requestReturn(account, body);
  else if (action === 'preferences') {
    const { orderEmail, marketingEmail, marketingSms } = body;
    if (typeof orderEmail !== 'boolean' || typeof marketingEmail !== 'boolean' || typeof marketingSms !== 'boolean') {
      throw new AccountError(400, 'Choose valid notification preferences.');
    }
    account.profile.preferences = { orderEmail, marketingEmail, marketingSms };
  } else if (action === 'email-send') {
    const email = account.profile.email;
    if (!email) throw new AccountError(400, 'Save an email address first.');
    limitAttempt('email:' + account.profile.id, 4);
    return fixtureChallenge(request, 'email', email, account.profile.id);
  } else if (action === 'email-verify') {
    const challenge = await verifyChallenge('email', body.code);
    if (challenge.id !== account.profile.id || challenge.destination !== account.profile.email) {
      throw new AccountError(400, 'Request a code for your current email address.');
    }
    const claimed = [...accountState.accounts.values()].some((other) => other !== account
      && other.profile.emailVerified && other.profile.email === challenge.destination);
    if (claimed) throw new AccountError(409, 'This email is already verified on another account.');
    account.profile.emailVerified = true;
  } else if (action === 'password') {
    limitAttempt('password:' + account.profile.id, 6);
    const password = validateNewPassword(body);
    const oldPassword = passwordValue(body.oldPassword, 1);
    const old = account.password;
    if (!oldPassword || !await validPassword(oldPassword, old)) throw new AccountError(400, 'The current password did not match.');
    const secret = await hashPassword(password);
    if (account.password !== old) throw new AccountError(409, 'This password was changed. Sign in again.');
    account.password = secret;
    endCustomerSessions(account.profile.id);
    await clearSession(request);
    return { signedOut: true };
  } else throw new AccountError(404, 'Account action not found.');
  return { saved: true };
}
