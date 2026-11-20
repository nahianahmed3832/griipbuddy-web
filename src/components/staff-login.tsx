"use client";

import { storefrontPath } from "@/config/storefront-path";

import { useState, type FormEvent } from "react";

export function StaffLogin() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    try {
      const response = await fetch(storefrontPath("/api/staff/sign-in"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: String(form.get("email")).trim(), password: form.get("password") }),
      });
      if (response.ok) { window.location.assign(storefrontPath("/staff")); return; }
      const result: { message: string } = await response.json();
      setError(result.message);
    } catch {
      setError("Couldn’t connect to staff sign-in. Try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="commerce-panel commerce-form" method="post" action={storefrontPath("/api/staff/sign-in")} onSubmit={signIn}>
      <label>Email address<input name="email" type="email" autoComplete="username" maxLength={254} required /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" maxLength={128} required /></label>
      {error && <p role="alert" className="commerce-message commerce-message--error">{error}</p>}
      <button className="button button--primary" type="submit" disabled={pending}>{pending ? "Signing in…" : "Sign in to staff dashboard"}</button>
    </form>
  );
}
