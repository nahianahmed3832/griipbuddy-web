"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { ChevronDown, UserRound, X } from "lucide-react";
import { createContext, useContext, useRef, useState, type FormEvent, type ReactNode } from "react";
import { storefrontPath } from "@/config/storefront-path";
import { useCartActions } from "@/lib/cart/browser";
import { endMeasurementSession } from "@/lib/measurement/browser";
import type { ListSummary, ShopSummary } from "@/lib/marketplace/constants";

export async function marketplaceRequest<T = unknown>(body: object, endpoint = "/api/marketplace"): Promise<T> {
  const response = await fetch(storefrontPath(endpoint), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.message ?? "Try again shortly.");
  return result.data;
}

export async function accountRequest(action: string, data: object = {}) {
  const response = await fetch(storefrontPath(`/api/shopper-auth/${action}`), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.message ?? "Account access is temporarily unavailable.");
  return result as { ok?: boolean; demoCode?: string };
}

type Shopper = { id: string; name: string };
type Selection = { favorites: string[]; lists: ListSummary[]; shops: ShopSummary[] };
type State = Selection & { shopper: Shopper | null; openAuth: () => void; favorite: (id: string, selected: boolean) => Promise<void>;
  follow: (shop: ShopSummary, selected: boolean) => Promise<void> };
const MarketplaceContext = createContext<State | null>(null);
export const useMarketplace = () => useContext(MarketplaceContext);

export function MarketplaceSession({ shopper, selections, children, hybrid = false }: { shopper: Shopper | null; selections: Selection; children: ReactNode; hybrid?: boolean }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const [register, setRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [method, setMethod] = useState<"email" | "phone">("email");
  const [phone, setPhone] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [favorites, setFavorites] = useState(selections.favorites);
  const [shops, setShops] = useState(selections.shops);

  function openAuth() {
    setRegister(false);
    setMethod("email");
    setCodeSent(false);
    setError("");
    setNotice("");
    dialog.current?.showModal();
  }

  async function authenticatePhone(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const phoneNumber = phone.replace(/[\s()-]/g, "");
    setError("");
    setPending(true);
    try {
      if (codeSent) {
        await accountRequest("phone-number/verify", { phoneNumber, code: data.get("code") });
        dialog.current?.close();
        router.refresh();
      } else {
        const result = await accountRequest("phone-number/send-otp", { phoneNumber });
        setCodeSent(true);
        setNotice(result.demoCode ? `Demo verification code is ${result.demoCode}.` : "Enter the verification code sent to your phone.");
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Try again shortly.");
    } finally { setPending(false); }
  }

  async function authenticate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    const password = String(data.get("password"));
    setError("");
    setNotice("");
    setPending(true);
    try {
      if (register) {
        await accountRequest("sign-up/email", { name: data.get("name"), email, password });
        setRegister(false);
        setNotice("Use your email and password to sign in.");
      } else {
        await accountRequest("sign-in/email", { email, password, rememberMe: data.has("remember") });
        dialog.current?.close();
        router.refresh();
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Try again shortly."); }
    finally { setPending(false); }
  }

  const state: State = { shopper, favorites, lists: selections.lists, shops, openAuth,
    async favorite(id, selected) {
      await marketplaceRequest({ action: "favorite", product: id, selected });
      setFavorites(current => selected ? [id, ...current.filter(item => item !== id)] : current.filter(item => item !== id));
    },
    async follow(shop, selected) {
      await marketplaceRequest({ action: "follow", shop: shop.id, selected });
      setShops(current => selected ? [shop, ...current.filter(item => item.id !== shop.id)] : current.filter(item => item.id !== shop.id));
    },
  };
  return <MarketplaceContext.Provider value={state}>
    {children}
    <dialog ref={dialog} className="store-dialog mp-sign-in" aria-labelledby="mp-sign-title" data-clarity-mask="true"
      onCancel={event => { if (pending) event.preventDefault(); }}>
      <button type="button" className="mp-dialog-close" aria-label="Close sign-in" disabled={pending} onClick={() => dialog.current?.close()}><X size={20}/></button>
      <div className="mp-dialog-heading"><h2 id="mp-sign-title">{register && method === "email" ? "Create your account" : "Sign in"}</h2>
        {method === "email" && <button type="button" className="button button--outline" disabled={pending} onClick={() => { setRegister(!register); setError(""); setNotice(""); }}>
          {register ? "Sign in" : "Register"}
        </button>}</div>
      {hybrid && <div className="mp-panel-links" aria-label="Sign-in method">
        {(["email", "phone"] as const).map(choice => <button type="button" key={choice} className="button button--outline"
          disabled={pending} aria-pressed={method === choice} onClick={() => { setMethod(choice); setError(""); setNotice(""); setCodeSent(false); }}>
          {choice === "email" ? "Email" : "Phone number"}
        </button>)}
      </div>}
      {notice && <p role="status">{notice}</p>}
      {method === "phone" ? <form className="store-dialog__fields" onSubmit={authenticatePhone}>
        <label className="store-dialog__field">Phone number<input type="tel" autoComplete="tel" required
          placeholder="+12025550143" value={phone} readOnly={codeSent} onChange={event => setPhone(event.target.value)} /></label>
        {!codeSent && <small>Enter the country code. For the preview, use +1 202 555 0143.</small>}
        {codeSent && <label className="store-dialog__field">Verification code<input name="code" autoComplete="one-time-code"
          inputMode="numeric" maxLength={6} pattern="[0-9]{6}" required /></label>}
        {error && <p className="store-dialog__error" role="alert">{error}</p>}
        <button className="button button--primary" disabled={pending}>{pending ? "Please wait…" : codeSent ? "Verify and sign in" : "Send verification code"}</button>
        {codeSent && <button type="button" className="link-button" disabled={pending}
          onClick={() => { setCodeSent(false); setError(""); setNotice(""); }}>Change number</button>}
      </form> : <form key={register ? "register" : "sign-in"} className="store-dialog__fields" onSubmit={authenticate}>
        {register && <label className="store-dialog__field">First name<input name="name" autoComplete="given-name" minLength={2} maxLength={65} required /></label>}
        <label className="store-dialog__field">Email address<input name="email" type="email" autoComplete="email" maxLength={254} required value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label className="store-dialog__field">Password<input name="password" type="password" autoComplete={register ? "new-password" : "current-password"}
          minLength={hybrid ? 8 : 10} maxLength={128} required /></label>
        {!register && <label className="mp-remember"><input type="checkbox" name="remember" defaultChecked /> Stay signed in</label>}
        {error && <p className="store-dialog__error" role="alert">{error}</p>}
        <button className="button button--primary" disabled={pending}>{pending ? "Please wait…" : register ? "Register" : "Sign in"}</button>
        {register && <small>Use a test email and a unique password for this preview. See the <Link href="/help/terms" onClick={() => dialog.current?.close()}>terms</Link> and
          <Link href="/help/privacy" onClick={() => dialog.current?.close()}> privacy policy</Link>.</small>}
      </form>}
      {hybrid && <div className="mp-google-preview">
        <button type="button" disabled aria-label="Sign in with Google, coming later">
          <Image src={storefrontPath("/identity/google-sign-in.png")} alt="" width={180} height={40} unoptimized />
        </button>
        <small>Google sign-in is coming later.</small>
      </div>}
    </dialog>
  </MarketplaceContext.Provider>;
}

export function ShopperMenu() {
  const state = useMarketplace()!;
  const { invalidate } = useCartActions();
  const router = useRouter();
  const menu = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState("");
  if (!state.shopper) return <button type="button" className="account-control__trigger mp-sign-button" aria-haspopup="dialog" onClick={state.openAuth}>Sign in</button>;
  return <details className="department-menu mp-account" ref={menu} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
  }} onKeyDown={event => { if (event.key === "Escape") event.currentTarget.open = false; }}>
    <summary aria-label="Your account"><UserRound size={21}/><ChevronDown size={13}/></summary>
    <nav aria-label="Your account" onClick={() => { if (menu.current) menu.current.open = false; }}>
      <strong>{state.shopper.name}</strong>
      <Link href="/orders">Purchases and reviews</Link>
      <Link href="/messages">Messages</Link>
      <Link href="/account">Account settings</Link>
      <Link href="/account/alerts" prefetch={false}>Product alerts</Link>
      <button type="button" onClick={() => void accountRequest("sign-out").then(() => {
        endMeasurementSession();
        invalidate?.();
        router.refresh();
      }, () => {
        setError("Couldn't sign out. Try again.");
        if (menu.current) menu.current.open = true;
      })}>Sign out</button>
      {error && <p role="alert">{error}</p>}
    </nav>
  </details>;
}

export function SignInGate({ children }: { children: ReactNode }) {
  const marketplace = useMarketplace();
  return <div className="mp-empty"><p>{children}</p><button className="button button--primary" type="button" onClick={marketplace?.openAuth}>Sign in</button></div>;
}
