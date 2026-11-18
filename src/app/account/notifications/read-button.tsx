"use client";

import { Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { marketplaceRequest } from "@/components/marketplace/session";
import type { MarketId } from "@/config/markets";
import { accountText, type AccountLanguage } from "@/lib/marketplace/account-language";

export function NotificationReadButton({ keys, label, context, language, market }: {
  keys: string[]; label: string; context?: string; language: AccountLanguage; market: MarketId;
}) {
  const router = useRouter();
  const [refreshing, startTransition] = useTransition();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function markRead() {
    setError("");
    setSaving(true);
    try {
      await marketplaceRequest({ action: "read-order-notifications", market, keys }, `/api/marketplace/account?market=${market}`);
      startTransition(() => router.refresh());
    } catch {
      setError(accountText(language, "Couldn’t update the notification. Try again.", "বিজ্ঞপ্তি আপডেট হয়নি। আবার চেষ্টা করুন।"));
    } finally {
      setSaving(false);
    }
  }

  return <div className="order-inbox__read">
    <button type="button" aria-label={context ? `${label} · ${context}` : undefined}
      disabled={saving || refreshing} onClick={markRead}>
      <Check size={15} aria-hidden="true" />{label}
    </button>
    {error && <p role="alert">{error}</p>}
  </div>;
}
