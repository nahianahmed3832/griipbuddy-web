"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { marketplaceRequest } from "./session";

export function useMarketplaceSubmission(errorMessage?: string) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  async function submit<T>(operation: () => Promise<T>, success: string, navigate?: (data: T) => string) {
    if (pending) return false;
    setPending(true); setFailed(false); setMessage("");
    try {
      const data = await operation();
      setMessage(success);
      if (navigate) router.push(navigate(data));
      router.refresh();
      return true;
    } catch (error) {
      setFailed(true);
      setMessage(errorMessage ?? (error instanceof Error ? error.message : "Try again shortly."));
      return false;
    } finally { setPending(false); }
  }
  return { pending, submit, feedback: message ? <p role={failed ? "alert" : "status"}>{message}</p> : null };
}

export function MarketplaceForm<T>({ fields, label, success, command, navigate, reset, endpoint, errorMessage, pendingLabel = "Saving…" }: {
  fields?: ReactNode; label: string; success: string; command: (form: FormData) => object;
  navigate?: (data: T) => string; reset?: boolean; endpoint?: string; errorMessage?: string; pendingLabel?: string;
}) {
  const state = useMarketplaceSubmission(errorMessage);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    if (await state.submit(() => marketplaceRequest<T>(command(new FormData(form)), endpoint), success, navigate) && reset) form.reset();
  }
  return <form className="mp-form" method="post" onSubmit={save}>
    {fields}<button type="submit" className={fields ? "button button--primary" : "button button--outline"} disabled={state.pending}>
      {state.pending ? pendingLabel : label}
    </button>{state.feedback}
  </form>;
}
