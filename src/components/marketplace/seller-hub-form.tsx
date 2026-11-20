"use client";

import { useRef, type FormEvent, type ReactNode } from "react";
import type { MarketId } from "@/config/markets";
import { useMarketplaceSubmission } from "./action-form";
import { marketplaceRequest } from "./session";

export function SellerHubForm({ section, market, command, children, label, success, reset = false }: {
  section: "hub" | "team"; market: MarketId; command: { action: string; shopId: string } & Record<string, string>;
  children?: ReactNode; label: string; success: string; reset?: boolean;
}) {
  const state = useMarketplaceSubmission();
  const attempt = useRef<{ fingerprint: string; operationId: string }>(null);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const input = new FormData(form);
    const fields = Object.fromEntries(input);
    const permissions = input.getAll("permissions").map(String).sort();
    delete fields["team-permissions"];
    delete fields.permissions;
    const payload = { ...command, ...fields, ...(input.has("team-permissions") && { permissions }) };
    const fingerprint = JSON.stringify(payload);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, operationId: crypto.randomUUID() };
    if (await state.submit(() => marketplaceRequest({ ...payload, operationId: attempt.current!.operationId },
      `/api/marketplace/seller/${section}?market=${market}`), success)) {
      attempt.current = null;
      if (reset) form.reset();
    }
  }
  return <form method="post" className={children ? "mp-form" : "seller-actions"} onSubmit={submit}>
    {children}
    <button type="submit" className={children ? "seller-button seller-button-primary" : "seller-button"} disabled={state.pending}>
      {state.pending ? "Saving…" : label}
    </button>
    {state.feedback}
  </form>;
}
