"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";
import { marketplaceRequest } from "./session";

const endpoint = "/api/marketplace/bd-orders";

export function BangladeshOrderHubForms({ linked, verifiedPhone, language }: {
  linked: boolean; verifiedPhone: boolean; language: AccountLanguage;
}) {
  const router = useRouter();
  const [challenge, setChallenge] = useState<{ id: string; kind: string; reference: string; email: string }>();
  const [method, setMethod] = useState<"email" | "phone">("email");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const t = (en: string, bn: string) => accountText(language, en, bn);

  async function submit(event: FormEvent<HTMLFormElement>, intent: "link" | "recover") {
    event.preventDefault();
    if (pending) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setNotice("");
    setError("");
    try {
      if (intent === "link") {
        await marketplaceRequest({ action: "link", phone: data.get("phone"), password: data.get("password") }, endpoint);
        form.reset();
        setNotice(t("Earlier account linked. Your orders are listed below.", "আগের অ্যাকাউন্ট যুক্ত হয়েছে। আপনার অর্ডারগুলো নিচে দেখুন।"));
      } else if (challenge) {
        await marketplaceRequest({ action: "confirm", kind: challenge.kind, reference: challenge.reference,
          email: challenge.email, challenge: challenge.id, code: data.get("code") }, endpoint);
        setChallenge(undefined);
        setNotice(t("Order saved to your account.", "অর্ডারটি আপনার অ্যাকাউন্টে যোগ হয়েছে।"));
      } else {
        const kind = String(data.get("kind"));
        const reference = String(data.get("reference"));
        const email = String(data.get("email") ?? "");
        if (method === "email") {
          const result = await marketplaceRequest<{ challenge: string }>({ action: "start", kind, reference, email }, endpoint);
          setChallenge({ id: result.challenge, kind, reference, email });
          setNotice(t("If those details match an eligible order, a code has been sent to the checkout email.",
            "তথ্য মিললে অর্ডারের ইমেইলে একটি কোড পাঠানো হয়েছে।"));
          return;
        }
        await marketplaceRequest({ action: "verified-phone", kind, reference }, endpoint);
        form.reset();
        setNotice(t("Order saved to your account.", "অর্ডারটি আপনার অ্যাকাউন্টে যোগ হয়েছে।"));
      }
      router.refresh();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("Try again shortly.", "কিছুক্ষণ পর আবার চেষ্টা করুন।"));
    } finally {
      setPending(false);
    }
  }

  function restart() {
    setChallenge(undefined);
    setNotice("");
    setError("");
  }

  return <div className="bd-order-hub-forms">
    <details className="commerce-panel">
      <summary>{t("Recover a guest order", "অতিথি অর্ডার পুনরুদ্ধার করুন")}</summary>
      <p>{t("Use the order reference and the contact provided at checkout.", "অর্ডার নম্বর এবং অর্ডার করার সময় দেওয়া যোগাযোগের তথ্য ব্যবহার করুন।")}</p>
      <form method="post" className="mp-form" onSubmit={event => void submit(event, "recover")} key={challenge ? "confirm" : "recover"}>
        {challenge ? <>
          <label>{t("Six-digit recovery code", "ছয় সংখ্যার পুনরুদ্ধার কোড")}
            <input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required />
          </label>
          <button className="button button--primary" disabled={pending}>{t("Verify and save order", "যাচাই করে অর্ডার সংরক্ষণ করুন")}</button>
          <button className="button button--outline" type="button" onClick={restart} disabled={pending}>{t("Start again", "আবার শুরু করুন")}</button>
        </> : <>
          <label>{t("Order type", "অর্ডারের ধরন")}
            <select name="kind"><option value="order">{t("Order", "অর্ডার")}</option><option value="preorder">{t("Pre-order", "প্রি-অর্ডার")}</option></select>
          </label>
          <label>{t("Order reference", "অর্ডার নম্বর")}<input name="reference" autoCapitalize="characters" maxLength={65} required /></label>
          {verifiedPhone && <label>{t("Verification", "যাচাইয়ের পদ্ধতি")}
            <select value={method} onChange={event => setMethod(event.target.value === "phone" ? "phone" : "email")}>
              <option value="email">{t("Code by checkout email", "অর্ডারের ইমেইলে কোড")}</option>
              <option value="phone">{t("Use my verified phone", "আমার যাচাইকৃত ফোন ব্যবহার করুন")}</option>
            </select>
          </label>}
          {method === "email" && <label>{t("Checkout email", "অর্ডারের ইমেইল")}
            <input name="email" type="email" autoComplete="email" maxLength={254} required />
          </label>}
          <button className="button button--primary" disabled={pending}>{method === "email" ? t("Send recovery code", "পুনরুদ্ধার কোড পাঠান") : t("Verify and save order", "যাচাই করে অর্ডার সংরক্ষণ করুন")}</button>
        </>}
      </form>
    </details>
    {!linked && <details className="commerce-panel">
      <summary>{t("Link an earlier Bangladesh account", "আগের বাংলাদেশ অ্যাকাউন্ট যুক্ত করুন")}</summary>
      <p>{t("Use your earlier store sign-in to show purchases and pre-orders from that account.",
        "আগের স্টোর অ্যাকাউন্ট দিয়ে সাইন ইন করলে সেই অ্যাকাউন্টের অর্ডার ও প্রি-অর্ডার দেখা যাবে।")}</p>
      <form method="post" className="mp-form" onSubmit={event => void submit(event, "link")}>
        <label>{t("Bangladesh phone number", "বাংলাদেশি ফোন নম্বর")}<input name="phone" type="tel" autoComplete="username" maxLength={24} required /></label>
        <label>{t("Earlier account password", "আগের অ্যাকাউন্টের পাসওয়ার্ড")}<input name="password" type="password" autoComplete="current-password" maxLength={128} required /></label>
        <button className="button button--primary" disabled={pending}>{t("Link account", "অ্যাকাউন্ট যুক্ত করুন")}</button>
      </form>
    </details>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
