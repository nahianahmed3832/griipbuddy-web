"use client";

import { Link2 } from "lucide-react";
import { useId, useState } from "react";
import type { Market } from "@/config/markets";
import type { Picks } from "@/lib/catalog/product-choice";

export function ShareProductSelection({ market, variantId, picks }: {
  market: Market; variantId?: string; picks?: Picks;
}) {
  const fieldId = useId();
  const [feedback, setFeedback] = useState<{ key: string; fallback: string | null }>();
  const options = Object.entries(picks ?? {});
  if (!variantId && !options.length) return null;
  const query = new URLSearchParams({ market: market.id, lang: market.locale });
  if (variantId) query.set("variant", variantId);
  else options.forEach(([axis, value]) => query.append("option", `${axis}:${value}`));
  const key = query.toString();
  const result = feedback?.key === key ? feedback : undefined;

  async function copy() {
    const url = new URL(window.location.origin);
    url.pathname = window.location.pathname;
    url.search = key;
    try {
      await navigator.clipboard.writeText(url.href);
      setFeedback({ key, fallback: null });
    } catch {
      setFeedback({ key, fallback: url.href });
    }
  }

  return <div>
    <button className="button button--outline" type="button" onClick={() => void copy()}>
      <Link2 size={17} aria-hidden="true" /> Copy product link
    </button>
    {result?.fallback && <label className="store-dialog__field" htmlFor={fieldId}>
      Copy this link to share your selection
      <input id={fieldId} type="url" value={result.fallback} readOnly onFocus={event => event.target.select()} />
    </label>}
    <p role="status" className={result && !result.fallback ? undefined : "sr-only"}>
      {result?.fallback ? "The product link is ready to copy." : result ? "Link copied with your selection." : ""}
    </p>
  </div>;
}
