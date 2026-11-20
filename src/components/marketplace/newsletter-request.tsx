"use client";

import { useRef, useState, type FormEvent } from "react";
import { storefrontPath } from "@/config/storefront-path";
import styles from "./newsletter-request.module.css";

export function NewsletterRequest() {
  const requestInProgress = useRef(false);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<{ text: string; error?: boolean }>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (requestInProgress.current) return;
    const form = event.currentTarget;
    const values = new FormData(form);
    requestInProgress.current = true;
    setPending(true);
    setResult(undefined);
    try {
      const response = await fetch(storefrontPath("/api/newsletter"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: values.get("email"), consent: values.has("consent") }),
      });
      const output: { message: string } = await response.json();
      setResult({ text: output.message, error: !response.ok });
      if (response.ok) form.reset();
    } catch {
      setResult({ text: "The request could not be saved. Try again when you’re connected.", error: true });
    } finally {
      requestInProgress.current = false;
      setPending(false);
    }
  }

  return <section className={styles.section} aria-labelledby="newsletter-heading" data-clarity-mask="true">
    <h2 id="newsletter-heading">Store updates</h2>
    <form method="post" onSubmit={submit} className={styles.form}>
      <label htmlFor="newsletter-email">Email address</label>
      <input id="newsletter-email" name="email" autoComplete="email" maxLength={254} type="email" required/>
      <label className={styles.checkbox}>
        <input name="consent" type="checkbox" required/>
        <span>I’d like email updates from GriipBuddy.</span>
      </label>
      <button type="submit" disabled={pending} className="button button--outline">{pending ? "Saving…" : "Request updates"}</button>
    </form>
    {result && <p role={result.error ? "alert" : "status"}>{result.text}</p>}
  </section>;
}
