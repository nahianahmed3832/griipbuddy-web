"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import type { MarketId } from "@/config/markets";
import { marketStoreHref } from "@/config/regional-path";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import { AccountRequestError, accountRequest, useMarketplace } from "./session";

function EmailAccessSignIn({ language }: { language: AccountLanguage }) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const marketplace = useMarketplace();
  return marketplace && <button type="button" className="button button--outline" onClick={marketplace.openAuth}>{t("Sign in", "সাইন ইন")}</button>;
}

type EmailAccessKind = "reset" | "verification";
const minimumResetPasswordLength = 10;

function EmailLinkForm({ kind, region, preview, language }: { kind: EmailAccessKind; region: MarketId; preview: boolean; language: AccountLanguage }) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const reset = kind === "reset";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const data = new FormData(event.currentTarget);
    setPending(true);
    setSent(false);
    setError("");
    try {
      await accountRequest(reset ? "request-password-reset" : "send-verification-email", { email: data.get("email"), region });
      setSent(true);
    } catch (failure) {
      setError(failure instanceof AccountRequestError && failure.status === 429
        ? t("Too many requests. Wait a few minutes and try again.", "অনেকবার অনুরোধ করেছেন। কিছুক্ষণ পরে আবার চেষ্টা করুন।")
        : t("We couldn’t request the email. Try again shortly.", "ইমেইল পাঠানোর অনুরোধ করা যায়নি। একটু পরে আবার চেষ্টা করুন।"));
    } finally {
      setPending(false);
    }
  }

  return <form className="mp-form" onSubmit={submit}>
    <label>{t("Email address", "ইমেইল ঠিকানা")}<input name="email" type="email" autoComplete="email" maxLength={254} required disabled={pending} /></label>
    {preview && <small>{t("Use a test address ending in @example.invalid.", "@example.invalid দিয়ে শেষ হওয়া পরীক্ষামূলক ঠিকানা ব্যবহার করুন।")}</small>}
    {sent && <p role="status">{preview
      ? t("If this address qualifies, the test email will appear in the staff preview inbox.", "ঠিকানাটি যাচাইযোগ্য হলে পরীক্ষামূলক ইমেইল কর্মীদের ইনবক্সে দেখা যাবে।")
      : <>{reset ? t("If this email is linked to an account, we’ll send a password reset link.", "এই ইমেইলে অ্যাকাউন্ট থাকলে পাসওয়ার্ড রিসেটের লিংক পাঠানো হবে।")
        : t("If this email needs verification, we’ll send a verification link.", "ইমেইল যাচাইয়ের প্রয়োজন হলে লিংক পাঠানো হবে।")} {t("Check your spam folder if it doesn’t arrive.", "ইমেইল না এলে স্প্যাম ফোল্ডার দেখুন।")}</>}</p>}
    {error && <p className="store-dialog__error" role="alert">{error}</p>}
    <button type="submit" className="button button--primary" disabled={pending}>
      {pending ? t("Requesting email…", "ইমেইলের অনুরোধ করা হচ্ছে…") : reset ? t("Send reset link", "রিসেট লিংক পাঠান") : t("Send verification email", "যাচাইকরণ ইমেইল পাঠান")}
    </button>
  </form>;
}

function EmailTokenForm({ kind, token, requestAnother, onSuccess, resetHref, language }: {
  kind: EmailAccessKind;
  token: string;
  requestAnother: () => void;
  onSuccess: () => void;
  resetHref: string;
  language: AccountLanguage;
}) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const [pending, setPending] = useState(false);
  const [expired, setExpired] = useState(false);
  const [error, setError] = useState("");
  const reset = kind === "reset";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || expired) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const password = data.get("password");
    setError("");
    if (reset && password !== data.get("confirm")) {
      setError(t("The passwords don’t match. Enter the same new password in both fields.", "পাসওয়ার্ড দুটি মেলেনি। দুই ঘরেই একই নতুন পাসওয়ার্ড লিখুন।"));
      return;
    }
    setPending(true);
    try {
      await accountRequest(reset ? "reset-password" : "verify-email", reset ? { token, newPassword: password } : { token, password });
      form.reset();
      onSuccess();
    } catch (failure) {
      if (failure instanceof AccountRequestError && failure.code === "INVALID_TOKEN") {
        form.reset();
        setExpired(true);
      } else {
        setError(failure instanceof AccountRequestError && failure.status === 429
          ? t("Too many attempts. Wait a few minutes and try again.", "অনেকবার চেষ্টা করেছেন। কিছুক্ষণ পরে আবার চেষ্টা করুন।")
          : failure instanceof AccountRequestError && failure.code === "INVALID_PASSWORD"
            ? t("That password didn’t match. Try again or reset your password.", "পাসওয়ার্ড মেলেনি। আবার চেষ্টা করুন বা পাসওয়ার্ড রিসেট করুন।")
          : reset ? t("We couldn’t reset the password. Try again or request another link.", "পাসওয়ার্ড রিসেট করা যায়নি। আবার চেষ্টা করুন বা নতুন লিংক চান।")
            : t("We couldn’t verify your email. Check your password or request another link.", "ইমেইল যাচাই করা যায়নি। পাসওয়ার্ড দেখুন অথবা নতুন লিংক চান।"));
      }
    } finally {
      setPending(false);
    }
  }

  if (expired) return <div className="mp-panel-links">
    <p role="alert">{t("This link is invalid or has expired. Request another link to continue.", "লিংকটি ভুল অথবা মেয়াদ শেষ। নতুন লিংক চাইতে পারেন।")}</p>
    <button type="button" className="button button--primary" onClick={requestAnother}>{t("Request another link", "নতুন লিংক চান")}</button>
  </div>;

  return <form className="mp-form" onSubmit={submit}>
    <fieldset disabled={pending} className="commerce-form">
      <legend className="sr-only">{reset ? t("Set a new password", "নতুন পাসওয়ার্ড সেট করুন") : t("Confirm your account password", "অ্যাকাউন্টের পাসওয়ার্ড নিশ্চিত করুন")}</legend>
      <label>{reset ? t("New password", "নতুন পাসওয়ার্ড") : t("Account password", "অ্যাকাউন্টের পাসওয়ার্ড")}
        <input name="password" type="password" autoComplete={reset ? "new-password" : "current-password"}
          minLength={reset ? minimumResetPasswordLength : undefined} maxLength={128} required />
      </label>
      {reset && <>
        <small>{t("Use at least 10 characters.", "অন্তত ১০ অক্ষর ব্যবহার করুন।")}</small>
        <label>{t("Confirm new password", "নতুন পাসওয়ার্ড নিশ্চিত করুন")}
          <input name="confirm" type="password" autoComplete="new-password" minLength={minimumResetPasswordLength} maxLength={128} required />
        </label>
      </>}
      {error && <p className="store-dialog__error" role="alert">{error}</p>}
      <button type="submit" className="button button--primary">
        {pending ? t("Please wait…", "অপেক্ষা করুন…") : reset ? t("Set new password", "নতুন পাসওয়ার্ড সেট করুন") : t("Verify email", "ইমেইল যাচাই করুন")}
      </button>
    </fieldset>
    {!pending && <div className="mp-panel-links">
      {!reset && <Link href={resetHref} prefetch={false}>{t("Forgot password?", "পাসওয়ার্ড ভুলে গেছেন?")}</Link>}
      <button type="button" className="link-button" onClick={requestAnother}>{t("Request another link", "নতুন লিংক চান")}</button>
    </div>}
  </form>;
}

export function EmailAccessPanel({ kind, region, hybrid, preview, language }: {
  kind: EmailAccessKind;
  region: MarketId;
  hybrid: boolean;
  preview: boolean;
  language: AccountLanguage;
}) {
  const t = (en: string, bn: string) => accountText(language, en, bn);
  const [token, setToken] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const reset = kind === "reset";
  const resetHref = marketStoreHref("/account/reset-password", hybrid ? region : undefined);

  useEffect(() => {
    let active = true;
    const read = () => {
      const tokens = new URLSearchParams(window.location.hash.slice(1)).getAll("token");
      return tokens.length === 1 ? tokens[0] : tokens.length ? "!" : "";
    };
    // Keep the token in this form even if the shopper follows an in-page link.
    queueMicrotask(() => { if (active) setToken(read()); });
    function onHashChange() {
      const next = read();
      if (next) {
        setCompleted(false);
        setToken(next);
      }
    }
    window.addEventListener("hashchange", onHashChange);
    return () => {
      active = false;
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  function clearLink() {
    const url = new URL(window.location.href);
    url.hash = "";
    window.history.replaceState(null, "", url);
    setToken("");
  }

  if (token === null) return <p role="status">{t("Loading account options…", "অ্যাকাউন্টের অপশন লোড হচ্ছে…")}</p>;
  if (completed) return <div className="mp-panel-links">
    <p role="status">{reset ? t("Password updated. Sign in with your new password.", "পাসওয়ার্ড পরিবর্তন হয়েছে। নতুন পাসওয়ার্ড দিয়ে সাইন ইন করুন।") : t("Email verified. You can now sign in.", "ইমেইল যাচাই হয়েছে। এখন সাইন ইন করতে পারেন।")}</p>
    <EmailAccessSignIn language={language} />
  </div>;

  const valid = reset ? /^[A-Za-z0-9_-]{16,128}$/.test(token)
    : token.length <= 2048 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
  if (valid) return <>
    {!reset && <p>{t("Enter your account password to confirm your email address.", "ইমেইল ঠিকানা নিশ্চিত করতে অ্যাকাউন্টের পাসওয়ার্ড লিখুন।")}</p>}
    <EmailTokenForm key={token} kind={kind} token={token} requestAnother={clearLink}
      language={language} resetHref={resetHref} onSuccess={() => { clearLink(); setCompleted(true); }} />
  </>;

  return <>
    {token ? <p role="alert">{t("This link is invalid or has expired. Request another link to continue.", "লিংকটি ভুল অথবা মেয়াদ শেষ। নতুন লিংক চাইতে পারেন।")}</p>
      : <p>{reset ? t("Enter the email address you used to create your account.", "অ্যাকাউন্ট তৈরি করার ইমেইল ঠিকানাটি লিখুন।")
        : t("Enter the email address you used to create your account to request another link.", "নতুন লিংকের জন্য অ্যাকাউন্ট তৈরি করার ইমেইল ঠিকানাটি লিখুন।")}</p>}
    <EmailLinkForm kind={kind} region={region} preview={preview} language={language} />
    <div className="mp-panel-links">
      <EmailAccessSignIn language={language} />
      {!reset && <Link href={resetHref} prefetch={false}>{t("Forgot password?", "পাসওয়ার্ড ভুলে গেছেন?")}</Link>}
    </div>
  </>;
}
