"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { marketplaceRequest } from "./session";

export function useMarketplaceSubmission() {
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
      setMessage(error instanceof Error ? error.message : "Try again shortly.");
      return false;
    } finally { setPending(false); }
  }
  return { pending, submit, feedback: message ? <p role={failed ? "alert" : "status"}>{message}</p> : null };
}

export function MarketplaceForm<T>({ fields, label, success, command, navigate, reset, endpoint, retryable = false }: {
  fields?: ReactNode; label: string; success: string; command: (form: FormData) => object;
  navigate?: (data: T) => string; reset?: boolean; endpoint?: string; retryable?: boolean;
}) {
  const state = useMarketplaceSubmission();
  const attempt = useRef<{ fingerprint: string; operationId: string }>(null);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const body = command(new FormData(form));
    if (retryable) {
      const fingerprint = JSON.stringify(body);
      if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, operationId: crypto.randomUUID() };
    }
    if (await state.submit(() => marketplaceRequest<T>(retryable ? { ...body, operationId: attempt.current!.operationId } : body, endpoint), success, navigate)) {
      attempt.current = null;
      if (reset) form.reset();
    }
  }
  return <form className="mp-form" method="post" onSubmit={save}>
    {fields}<button type="submit" className={fields ? "button button--primary" : "button button--outline"} disabled={state.pending}>
      {state.pending ? "Saving…" : label}
    </button>{state.feedback}
  </form>;
}
