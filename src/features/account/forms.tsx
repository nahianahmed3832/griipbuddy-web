'use client';

import { ArrowRight, LogOut } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { marketHref, type Market } from '@/features/catalog/catalog';
import { clearTransferredGuestCart, guestTransfer, useCart } from '@/features/cart/store';
import { accountRequest } from './client';
import type { Address, Customer, CustomerOrder } from './contracts';

type AuthStep = 'login' | 'register' | 'verify' | 'recover' | 'reset';
const noticeKey = 'griipbuddy-account-notice';
const subscribeHydration = () => () => {};

function useAction() {
  const hydrated = useSyncExternalStore(subscribeHydration, () => true, () => false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  async function run<T>(perform: () => Promise<T>, success?: string) {
    if (pending || !hydrated) return;
    setPending(true);
    setError('');
    setMessage('');
    try {
      const result = await perform();
      if (success) setMessage(success);
      return result;
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Please try again.');
    } finally {
      setPending(false);
    }
  }
  return { pending: pending || !hydrated, error, message, run };
}

function Feedback({ error, message }: { error?: string; message?: string }) {
  return error ? <p role="alert" className="account-feedback is-error">{error}</p>
    : message ? <p role="status" className="account-feedback">{message}</p> : null;
}

function values(event: FormEvent<HTMLFormElement>) {
  event.preventDefault();
  return Object.fromEntries(new FormData(event.currentTarget));
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="account-field"><span>{label}</span>{children}</label>;
}

function CodeField({ length = 6 }: { length?: number }) {
  return <Field label="Verification code">
    <input name="code" autoComplete="one-time-code" inputMode="numeric" pattern={`[0-9]{${length}}`} maxLength={length} required />
  </Field>;
}

function NewPasswordFields() {
  return <>
    <Field label="New password"><input type="password" name="password" autoComplete="new-password" minLength={12} maxLength={128} required /></Field>
    <Field label="Confirm password"><input type="password" name="confirm" autoComplete="new-password" minLength={12} maxLength={128} required /></Field>
    <p className="account-hint">Use at least 12 characters.</p>
  </>;
}

function PreviewCode({ code, channel = 'SMS' }: { code: string; channel?: string }) {
  return <div className="account-preview-code">Preview {channel} code <output aria-label={'Preview ' + channel + ' code'}>{code}</output></div>;
}

export function AuthForm({ initial, market, fixture, integrated, destination, returnQuery }: {
  initial: 'login' | 'register' | 'recover'; market: Market; fixture: boolean; integrated?: boolean; destination?: string; returnQuery: string;
}) {
  const [step, setStep] = useState<AuthStep>(initial);
  const [method, setMethod] = useState<'phone' | 'email'>('phone');
  const [code, setCode] = useState('');
  const [notice, setNotice] = useState('');
  const action = useAction();
  const titles = { login: 'Sign in', register: 'Create an account', verify: 'Verify your phone', recover: 'Forgot password', reset: 'Reset password' };
  const submits = { login: 'Sign in', register: 'Send verification code', verify: 'Verify and continue', recover: 'Send reset code', reset: 'Reset password' };
  const descriptions = {
    login: fixture ? 'Use your phone number or verified email.' : 'Use the verified phone number on your GriipBuddy account.',
    register: 'Create an account to keep your bag, saved products and orders together.',
    recover: 'Enter the phone number on your account.',
    verify: 'Enter the code issued for this request. Codes expire after five minutes.',
    reset: 'Enter the code issued for this request. Codes expire after five minutes.',
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    const body = values(event);
    setNotice('');
    const guest = step === 'login' || step === 'verify' ? guestTransfer() : undefined;
    const result = await action.run(() => accountRequest<{
      signedIn?: boolean; transferred?: boolean; message?: string; next?: 'verify' | 'reset'; previewCode?: string; reset?: boolean;
    }>(step, { ...body, guest }));
    if (!result) return;
    if (result.signedIn) {
      if (result.transferred) clearTransferredGuestCart(guest);
      const message = result.message ?? (result.transferred ? 'Your guest bag was added to your account.' : '');
      if (message) {
        try { window.sessionStorage.setItem(noticeKey, message); } catch { /* Continue with the account. */ }
      }
      window.location.assign(marketHref(market, destination ?? '/account'));
      return;
    }
    if (result.next) {
      setStep(result.next);
      setCode(result.previewCode ?? '');
      if (result.next === 'reset') setNotice('If the phone is registered, a code has been issued.');
    }
    if (result.reset) {
      setStep('login');
      setCode('');
      setNotice('Password updated. Sign in with your new password.');
    }
  }

  return <section className="account-auth-card" aria-labelledby="account-auth-title">
    <h1 id="account-auth-title">{titles[step]}</h1>
    <p>{descriptions[step]}</p>
    {!fixture && step !== 'login' && !(integrated && ['register','verify'].includes(step)) ? <div className="account-feedback">
      This service is unavailable for recovered accounts. <Link className="text-link" href={marketHref(market, '/contact-and-support')}>Contact support</Link>
    </div> : <form key={step} method="post" className="account-form" onSubmit={(event) => void submit(event)}>
      {step === 'login' && <div className="account-methods" aria-label="Sign-in method">
        <button type="button" aria-pressed={method === 'phone'} onClick={() => setMethod('phone')}>Phone</button>
        <button type="button" aria-pressed={method === 'email'} disabled={!fixture} onClick={() => setMethod('email')}>Email</button>
      </div>}
      {step === 'register' && <>
        <Field label="Full name"><input name="name" autoComplete="name" maxLength={120} required /></Field>
        {fixture && <Field label="Email address (optional)"><input name="email" type="email" autoComplete="email" maxLength={254} /></Field>}
      </>}
      {((step === 'login' && method === 'phone') || step === 'register' || step === 'recover' || (integrated && step === 'verify')) &&
        <Field key="phone" label="Phone number"><input name="phone" type="tel" autoComplete="tel" maxLength={30} required /></Field>}
      {step === 'login' && method === 'email' &&
        <Field key="email" label="Email address"><input name="email" type="email" autoComplete="email" maxLength={254} required /></Field>}
      {step === 'login' && <Field label="Password"><input name="password" type="password" autoComplete="current-password" maxLength={128} required /></Field>}
      {(step === 'verify' || step === 'reset') && <CodeField length={integrated && step === 'verify' ? 5 : 6} />}
      {(step === 'register' || step === 'reset') && <NewPasswordFields />}
      {code && <PreviewCode code={code} />}
      <Feedback error={action.error} message={notice} />
      <button type="submit" className="button button-primary" disabled={action.pending}>{action.pending ? 'Please wait…' : submits[step]}<ArrowRight size={16} aria-hidden /></button>
    </form>}
    {step === 'login' ? <>
      <div className="account-google">
        <button type="button" className="button button-outline" disabled aria-describedby="google-design-note">
          <span className="account-google-mark" aria-hidden>G</span> Continue with Google
        </button>
        <p id="google-design-note">Design preview</p>
      </div>
      <div className="account-auth-links">
        <Link className="text-link" href={marketHref(market, '/account/recover') + returnQuery}>Forgot password</Link>
        <Link className="text-link" href={marketHref(market, '/account/register') + returnQuery}>Create an account</Link>
      </div>
    </> : <div className="account-auth-links">
      <Link className="text-link" href={marketHref(market, '/login') + returnQuery}>Back to sign in</Link>
      {(step === 'verify' || step === 'reset') && <button type="button" className="text-link" onClick={() => {
        setStep(step === 'verify' ? 'register' : 'recover');
        setCode('');
        setNotice('');
      }}>Request another code</button>}
    </div>}
  </section>;
}

export function AccountNotice() {
  const [notice, setNotice] = useState('');
  useEffect(() => {
    try {
      const message = window.sessionStorage.getItem(noticeKey);
      if (message) { setNotice(message); window.sessionStorage.removeItem(noticeKey); }
    } catch { /* This notice is optional. */ }
  }, []);
  return notice ? <Feedback message={notice} /> : null;
}

export function AccountBagLink({ market }: { market: Market }) {
  const { lines } = useCart();
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  return <Link href={marketHref(market, '/cart')} className="text-link">View shopping bag{count > 0 ? ' (' + count + ')' : ''}<ArrowRight size={15} aria-hidden /></Link>;
}

export function SignOut({ market }: { market: Market }) {
  const action = useAction();
  return <div className="account-sign-out">
    <button type="button" className="text-link" disabled={action.pending} onClick={async () => {
      const result = await action.run(() => accountRequest('logout'));
      if (result) window.location.assign(marketHref(market, '/login'));
    }}><LogOut size={15} aria-hidden /> Sign out</button>
    <Feedback error={action.error} />
  </div>;
}

export function ProfileForm({ customer }: { customer: Customer }) {
  const router = useRouter();
  const action = useAction();
  return <form method="post" className="account-form" onSubmit={async (event) => {
    const data = values(event);
    if (await action.run(() => accountRequest('profile', data), 'Personal information saved.')) router.refresh();
  }}>
    <Field label="Full name"><input name="name" autoComplete="name" defaultValue={customer.name} maxLength={120} required /></Field>
    <Field label="Email address"><input name="email" type="email" autoComplete="email" defaultValue={customer.email} maxLength={254} /></Field>
    <Field label="Verified phone"><input value={customer.phone} readOnly /></Field>
    <Feedback error={action.error} message={action.message} />
    <button type="submit" className="button button-primary" disabled={action.pending}>Save personal information</button>
  </form>;
}

export function AddressesForm({ customer }: { customer: Customer }) {
  const router = useRouter();
  const action = useAction();
  const [editing, setEditing] = useState<string>();
  const selected = customer.addresses.find((address) => address.id === editing);
  async function save(operation: string, data: Record<string, unknown>) {
    if (await action.run(() => accountRequest('address', { ...data, operation }), 'Addresses updated.')) {
      setEditing(undefined);
      router.refresh();
      return true;
    }
    return false;
  }
  return <div className="account-addresses">
    <div className="account-address-grid">{customer.addresses.map((address) => (
      <div className="account-address" key={address.id}>
        <div><h3>{address.label}</h3>{customer.defaultAddress === address.id && <span className="account-chip">Default</span>}</div>
        <AddressText address={address} />
        <div className="account-inline-actions">
          <button type="button" className="text-link" onClick={() => setEditing(address.id)}>Edit {address.label}</button>
          {customer.defaultAddress !== address.id && <button type="button" className="text-link" disabled={action.pending}
            onClick={() => void save('default', { id: address.id })}>Set {address.label} as default</button>}
          <button type="button" className="text-link" disabled={action.pending}
            onClick={() => void save('remove', { id: address.id })}>Remove {address.label}</button>
        </div>
      </div>
    ))}</div>
    {!customer.addresses.length && <p className="account-hint">You have no saved addresses yet.</p>}
    <form key={selected?.id ?? 'new'} method="post" className="account-form" onSubmit={async (event) => {
      const form = event.currentTarget;
      const data = values(event);
      if (await save('save', { ...data, id: selected?.id })) form.reset();
    }}>
      <h3>{selected ? 'Edit address' : 'Add an address'}</h3>
      <Field label="Address label"><input name="label" defaultValue={selected?.label} maxLength={50} required /></Field>
      <Field label="Street address"><input name="street" defaultValue={selected?.street} autoComplete="street-address" maxLength={200} required /></Field>
      <div className="account-form-columns">
        <Field label="City"><input name="city" defaultValue={selected?.city} autoComplete="address-level2" maxLength={80} required /></Field>
        <Field label="Region"><input name="region" defaultValue={selected?.region} autoComplete="address-level1" maxLength={80} /></Field>
        <Field label="Postal code"><input name="postalCode" defaultValue={selected?.postalCode} autoComplete="postal-code" maxLength={20} /></Field>
        <Field label="Country code"><input name="country" defaultValue={selected?.country} autoComplete="country" placeholder="BD" pattern="[A-Za-z]{2}" maxLength={2} required /></Field>
      </div>
      <Feedback error={action.error} message={action.message} />
      <div className="account-inline-actions">
        <button type="submit" className="button button-primary" disabled={action.pending}>Save address</button>
        {selected && <button type="button" className="text-link" onClick={() => setEditing(undefined)}>Cancel editing</button>}
      </div>
    </form>
  </div>;
}

export function AddressText({ address }: { address: Address }) {
  return <address>{address.street}<br />{[address.city, address.region, address.postalCode, address.country].filter(Boolean).join(', ')}</address>;
}

export function SecurityForms({ customer, market }: { customer: Customer; market: Market }) {
  const router = useRouter();
  const email = useAction();
  const password = useAction();
  const [code, setCode] = useState('');
  return <div className="account-form-stack">
    <div className="account-form">
      <h3>Email verification</h3>
      <p>{customer.email ? customer.email + (customer.emailVerified ? ' · Verified' : ' · Unverified') : 'Save an email address in Personal information first.'}</p>
      {customer.email && !customer.emailVerified && <>
        <button type="button" className="button button-outline" disabled={email.pending} onClick={async () => {
          const result = await email.run(() => accountRequest<{ previewCode: string }>('email-send'));
          if (result) setCode(result.previewCode);
        }}>Send email verification code</button>
        {code && <form method="post" className="account-form" onSubmit={async (event) => {
          const data = values(event);
          if (await email.run(() => accountRequest('email-verify', data), 'Email verified.')) { setCode(''); router.refresh(); }
        }}>
          <PreviewCode code={code} channel="email" /><CodeField />
          <button type="submit" className="button button-primary" disabled={email.pending}>Verify email</button>
        </form>}
      </>}
      <Feedback error={email.error} message={email.message} />
    </div>
    <form method="post" className="account-form" onSubmit={async (event) => {
      const data = values(event);
      if (await password.run(() => accountRequest('password', data))) window.location.assign(marketHref(market, '/login'));
    }}>
      <h3>Change password</h3>
      <Field label="Current password"><input name="oldPassword" type="password" autoComplete="current-password" maxLength={128} required /></Field>
      <NewPasswordFields /><Feedback error={password.error} />
      <button type="submit" className="button button-primary" disabled={password.pending}>Change password and sign out</button>
    </form>
  </div>;
}

export function PreferencesForm({ customer }: { customer: Customer }) {
  const action = useAction();
  const preferences = customer.preferences;
  return <form method="post" className="account-form" onSubmit={(event) => {
    const data = values(event);
    void action.run(() => accountRequest('preferences', {
      orderEmail: data.orderEmail === 'on', marketingEmail: data.marketingEmail === 'on', marketingSms: data.marketingSms === 'on',
    }), 'Notification preferences saved.');
  }}>
    <label className="account-check"><input name="orderEmail" type="checkbox" defaultChecked={preferences?.orderEmail} /> Order updates by email</label>
    <label className="account-check"><input name="marketingEmail" type="checkbox" defaultChecked={preferences?.marketingEmail} /> Offers by email</label>
    <label className="account-check"><input name="marketingSms" type="checkbox" defaultChecked={preferences?.marketingSms} /> Offers by SMS</label>
    <Feedback error={action.error} message={action.message} />
    <button type="submit" className="button button-primary" disabled={action.pending}>Save preferences</button>
  </form>;
}

export function ReturnForm({ orders, orderId }: { orders: CustomerOrder[]; orderId?: string }) {
  const router = useRouter();
  const action = useAction();
  if (!orders.length) return <p className="account-hint">There are no delivered orders available for a new request.</p>;
  return <form method="post" className="account-form" onSubmit={async (event) => {
    const form = event.currentTarget;
    const data = values(event);
    if (await action.run(() => accountRequest('return', data), 'Request submitted in the preview.')) { form.reset(); router.refresh(); }
  }}>
    <Field label="Order"><select name="orderId" defaultValue={orderId ?? ''} required>
      <option value="" disabled>Select an order</option>{orders.map((order) => <option key={order.id} value={order.id}>Order {order.number}</option>)}
    </select></Field>
    <Field label="Request type"><select name="kind"><option value="return">Return</option><option value="refund">Refund</option></select></Field>
    <Field label="Reason"><textarea name="reason" rows={4} maxLength={500} required /></Field>
    <Feedback error={action.error} message={action.message} />
    <button type="submit" className="button button-primary" disabled={action.pending}>Submit request</button>
  </form>;
}
