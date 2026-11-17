"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, UserRound, X } from "lucide-react";
import { createContext, useContext, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { MarketId } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import type { ListSummary, ShopSummary } from "@/lib/marketplace/constants";

export async function marketplaceRequest<T = unknown>(body: object, endpoint = "/api/marketplace"): Promise<T> {
  const response = await fetch(storefrontPath(endpoint), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body) });
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw new Error(result?.message ?? "Try again shortly.");
  return result.data;
}

export class AccountRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly code?: string) {
    super(message);
  }
}

export async function accountRequest(action: string, data: object = {}) {
  const response = await fetch(storefrontPath(`/api/shopper-auth/${action}`), { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data) }).catch(() => { throw new AccountRequestError("Sign-in is temporarily unavailable. Try again shortly.", 503); });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new AccountRequestError(
    typeof result.message === "string" ? result.message : "Account access is temporarily unavailable.",
    response.status, typeof result.code === "string" ? result.code : undefined,
  );
  return result as { ok?: boolean; demoCode?: string };
}

type Shopper = { id: string; name: string };
type Selection = { favorites: string[]; lists: ListSummary[]; shops: ShopSummary[] };
type State = Selection & { shopper: Shopper | null; language: AccountLanguage; region?: MarketId; openAuth: () => void; favorite: (id: string, selected: boolean) => Promise<void>;
  follow: (shop: ShopSummary, selected: boolean) => Promise<void> };
const MarketplaceContext = createContext<State | null>(null);
export const useMarketplace = () => useContext(MarketplaceContext);

export function MarketplaceSession({ shopper, selections, children, hybrid = false, marketId = "bd", emailLinks = false, emailPreview = false, language = "en", handoffStart }: {
  shopper: Shopper | null;
  selections: Selection;
  children: ReactNode;
  hybrid?: boolean;
  marketId?: MarketId;
  emailLinks?: boolean;
  emailPreview?: boolean;
  language?: AccountLanguage;
  handoffStart?: string;
}) {
  const router = useRouter();
  const signinIssue = useSearchParams().get("signin");
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
  const region = hybrid ? marketId : undefined;
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const resetPath = marketStoreHref("/account/reset-password", region);
  const verificationPath = marketStoreHref("/account/verify-email", region);

  function openAuth() {
    if (handoffStart) {
      window.location.assign(`${handoffStart}&return=${encodeURIComponent(window.location.pathname)}`);
      return;
    }
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
        setNotice(result.demoCode ? `Demo verification code is ${result.demoCode}.` : t("Enter the verification code sent to your phone.", "ফোনে পাঠানো যাচাইকরণ কোড লিখুন।"));
      }
    } catch (failure) {
      setError(language === "bn" ? "সাইন ইন করা যায়নি। তথ্য যাচাই করে আবার চেষ্টা করুন।" : failure instanceof Error ? failure.message : "Try again shortly.");
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
        await accountRequest("sign-up/email", { name: data.get("name"), email, password, ...(emailLinks && { region: marketId }) });
        setRegister(false);
        setNotice(emailLinks
          ? emailPreview ? t("In this preview, verification links appear in the staff preview inbox. You can request another link below.", "এই পরীক্ষামূলক সাইটে যাচাইকরণ লিংক কর্মীদের ইনবক্সে আসে। নিচে আরেকটি লিংক চাইতে পারেন।")
            : t("Check your inbox for a verification link before signing in. You can request another link below.", "সাইন ইন করার আগে ইনবক্সে যাচাইকরণ লিংক দেখুন। নিচে আরেকটি লিংক চাইতে পারেন।")
          : t("Use your email and password to sign in.", "ইমেইল ও পাসওয়ার্ড দিয়ে সাইন ইন করুন।"));
      } else {
        await accountRequest("sign-in/email", { email, password, rememberMe: data.has("remember") });
        dialog.current?.close();
        router.refresh();
      }
    } catch (failure) {
      setError(failure instanceof AccountRequestError && failure.status >= 500
        ? t("Sign-in is temporarily unavailable. Try again shortly.", "এখন সাইন ইন করা যাচ্ছে না। কিছুক্ষণ পরে আবার চেষ্টা করুন।")
        : failure instanceof AccountRequestError && failure.code === "EMAIL_NOT_VERIFIED"
        ? t("Verify your email before signing in. Request another verification email below.", "সাইন ইন করার আগে ইমেইল যাচাই করুন। নিচে নতুন যাচাইকরণ ইমেইল চাইতে পারেন।")
        : language === "bn" ? "সাইন ইন করা যায়নি। তথ্য যাচাই করে আবার চেষ্টা করুন।" : failure instanceof Error ? failure.message : "Try again shortly.");
    }
    finally { setPending(false); }
  }

  const state: State = { shopper, language, region, favorites, lists: selections.lists, shops, openAuth,
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
    {handoffStart && (signinIssue === "expired" || signinIssue === "unavailable") &&
      <p role="status" className="shell">{signinIssue === "expired"
        ? t("Your sign-in request expired. Sign in again to continue.", "সাইন ইন অনুরোধের মেয়াদ শেষ হয়েছে। চালিয়ে যেতে আবার সাইন ইন করুন।")
        : t("Sign-in is temporarily unavailable. Try again shortly.", "এখন সাইন ইন করা যাচ্ছে না। কিছুক্ষণ পরে আবার চেষ্টা করুন।")}</p>}
    {children}
    <dialog ref={dialog} lang={language} className="store-dialog mp-sign-in" aria-labelledby="mp-sign-title" onCancel={event => { if (pending) event.preventDefault(); }}>
      <button type="button" className="mp-dialog-close" aria-label={t("Close sign-in", "সাইন ইন বন্ধ করুন")} disabled={pending} onClick={() => dialog.current?.close()}><X size={20}/></button>
      <div className="mp-dialog-heading"><h2 id="mp-sign-title">{register && method === "email" ? t("Create your account", "অ্যাকাউন্ট তৈরি করুন") : t("Sign in", "সাইন ইন")}</h2>
        {method === "email" && <button type="button" className="button button--outline" disabled={pending} onClick={() => { setRegister(!register); setError(""); setNotice(""); }}>
          {register ? t("Sign in", "সাইন ইন") : t("Register", "নিবন্ধন করুন")}
        </button>}</div>
      {hybrid && <div className="mp-panel-links" aria-label={t("Sign-in method", "সাইন ইন পদ্ধতি")}>
        {(["email", "phone"] as const).map(choice => <button type="button" key={choice} className="button button--outline"
          disabled={pending} aria-pressed={method === choice} onClick={() => { setMethod(choice); setError(""); setNotice(""); setCodeSent(false); }}>
          {choice === "email" ? t("Email", "ইমেইল") : t("Phone number", "ফোন নম্বর")}
        </button>)}
      </div>}
      {notice && <p role="status">{notice}</p>}
      {method === "phone" ? <form className="store-dialog__fields" onSubmit={authenticatePhone}>
        <label className="store-dialog__field">{t("Phone number", "ফোন নম্বর")}<input type="tel" autoComplete="tel" required
          placeholder="+12025550143" value={phone} readOnly={codeSent} onChange={event => setPhone(event.target.value)} /></label>
        {!codeSent && <small>{t("Enter the country code. For the preview, use +1 202 555 0143.", "দেশের কোডসহ নম্বর দিন। পরীক্ষার জন্য +১ ২০২ ৫৫৫ ০১৪৩ ব্যবহার করুন।")}</small>}
        {codeSent && <label className="store-dialog__field">{t("Verification code", "যাচাইকরণ কোড")}<input name="code" autoComplete="one-time-code"
          inputMode="numeric" maxLength={6} pattern="[0-9]{6}" required /></label>}
        {error && <p className="store-dialog__error" role="alert">{error}</p>}
        <button className="button button--primary" disabled={pending}>{pending ? t("Please wait…", "অপেক্ষা করুন…") : codeSent ? t("Verify and sign in", "যাচাই করে সাইন ইন করুন") : t("Send verification code", "যাচাইকরণ কোড পাঠান")}</button>
        {codeSent && <button type="button" className="link-button" disabled={pending}
          onClick={() => { setCodeSent(false); setError(""); setNotice(""); }}>{t("Change number", "নম্বর বদলান")}</button>}
      </form> : <form key={register ? "register" : "sign-in"} className="store-dialog__fields" onSubmit={authenticate}>
        {register && <label className="store-dialog__field">{t("First name", "নাম")}<input name="name" autoComplete="given-name" minLength={2} maxLength={65} required /></label>}
        <label className="store-dialog__field">{t("Email address", "ইমেইল ঠিকানা")}<input name="email" type="email" autoComplete="email" maxLength={254} required value={email} onChange={event => setEmail(event.target.value)} /></label>
        <label className="store-dialog__field">{t("Password", "পাসওয়ার্ড")}<input name="password" type="password" autoComplete={register ? "new-password" : "current-password"}
          minLength={hybrid ? 8 : 10} maxLength={128} required /></label>
        {!register && <label className="mp-remember"><input type="checkbox" name="remember" defaultChecked />{t("Stay signed in", "সাইন ইন রাখুন")}</label>}
        {error && <p className="store-dialog__error" role="alert">{error}</p>}
        <button className="button button--primary" disabled={pending}>{pending ? t("Please wait…", "অপেক্ষা করুন…") : register ? t("Register", "নিবন্ধন করুন") : t("Sign in", "সাইন ইন")}</button>
        {!register && emailLinks && !pending && <div className="mp-panel-links">
          <Link href={resetPath} prefetch={false} onClick={() => dialog.current?.close()}>{t("Forgot password?", "পাসওয়ার্ড ভুলে গেছেন?")}</Link>
          <Link href={verificationPath} prefetch={false} onClick={() => dialog.current?.close()}>{t("Resend verification email", "যাচাইকরণ ইমেইল আবার পাঠান")}</Link>
        </div>}
        {register && <small>{emailPreview ? t("Use a test address ending in @example.invalid and a unique password. ", "@example.invalid দিয়ে শেষ হওয়া পরীক্ষামূলক ঠিকানা ও আলাদা পাসওয়ার্ড ব্যবহার করুন। ")
          : emailLinks ? "" : t("Use a test email and a unique password for this preview. ", "পরীক্ষার জন্য একটি ইমেইল ও আলাদা পাসওয়ার্ড ব্যবহার করুন। ")}
          See the <Link href="/help/terms" onClick={() => dialog.current?.close()}>terms</Link> and
          <Link href="/help/privacy" onClick={() => dialog.current?.close()}> privacy policy</Link>.</small>}
      </form>}
      {hybrid && <div className="mp-google-preview">
        <button type="button" disabled aria-label="Sign in with Google, coming later">
          <Image src={storefrontPath("/identity/google-sign-in.png")} alt="" width={180} height={40} unoptimized />
        </button>
        <small>{t("Google sign-in is coming later.", "Google দিয়ে সাইন ইন পরে পাওয়া যাবে।")}</small>
      </div>}
    </dialog>
  </MarketplaceContext.Provider>;
}

export function ShopperMenu() {
  const state = useMarketplace()!;
  const router = useRouter();
  const menu = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState("");
  const t = (en: string, bn: string) => accountText(state.language, en, bn);
  const href = (path: string) => marketStoreHref(path, state.region);
  if (!state.shopper) return <button type="button" className="account-control__trigger mp-sign-button" aria-haspopup="dialog" onClick={state.openAuth}>{t("Sign in", "সাইন ইন")}</button>;
  return <details className="department-menu mp-account" ref={menu} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
  }} onKeyDown={event => { if (event.key === "Escape") event.currentTarget.open = false; }}>
    <summary aria-label={t("Your account", "আপনার অ্যাকাউন্ট")}><UserRound size={21}/><ChevronDown size={13}/></summary>
    <nav aria-label={t("Your account", "আপনার অ্যাকাউন্ট")} onClick={() => { if (menu.current) menu.current.open = false; }}>
      <strong>{state.shopper.name}</strong>
      <Link href={href("/orders")}>{t("My orders", "আমার অর্ডার")}</Link>
      <Link href={href("/account/help")}>{t("Help & returns", "সহায়তা ও ফেরত")}</Link>
      <Link href={href("/account")}>{t("My account", "আমার অ্যাকাউন্ট")}</Link>
      <button type="button" onClick={() => void accountRequest("sign-out").then(() => router.refresh(), () => {
        setError("Couldn't sign out. Try again.");
        if (menu.current) menu.current.open = true;
      })}>{t("Sign out", "সাইন আউট")}</button>
      {error && <p role="alert">{error}</p>}
    </nav>
  </details>;
}

export function SignInGate({ children, language }: { children: ReactNode; language?: AccountLanguage }) {
  const marketplace = useMarketplace();
  return <div className="mp-empty"><p>{children}</p><button className="button button--primary" type="button" onClick={marketplace?.openAuth}>{accountText(language ?? marketplace?.language ?? "en", "Sign in", "সাইন ইন")}</button></div>;
}
