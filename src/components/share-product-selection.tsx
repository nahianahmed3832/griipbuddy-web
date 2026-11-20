"use client";

import { Link2, Share2 } from "lucide-react";
import { useId, useState, useSyncExternalStore } from "react";
import type { Market } from "@/config/markets";
import { productLandingPath, regionalMarket } from "@/config/regional-path";
import { storefrontBasePath, storefrontPath } from "@/config/storefront-path";
import type { Picks } from "@/lib/catalog/product-choice";

const subscribe = () => () => {};

export function ShareProductSelection({ slug, market, variantId, picks }: {
  slug: string; market: Market; variantId?: string; picks?: Picks;
}) {
  const fieldId = useId();
  const nativeShare = useSyncExternalStore(subscribe, () => typeof navigator.share === "function", () => false);
  const [feedback, setFeedback] = useState<{ key: string; message: string; fallback?: string }>();
  const options = Object.entries(picks ?? {});
  if (!variantId && !options.length) return null;
  const key = JSON.stringify([slug, market.id, market.locale, variantId ?? options]);
  const result = feedback?.key === key ? feedback : undefined;

  function shareUrl() {
    const regional = Boolean(regionalMarket(window.location.pathname.slice(storefrontBasePath.length)));
    const path = productLandingPath(slug, market.id, regional, variantId);
    const url = new URL(storefrontPath(path), window.location.origin);
    url.searchParams.set("lang", market.locale);
    if (!variantId) options.forEach(([axis, value]) => url.searchParams.append("option", `${axis}:${value}`));
    return url.href;
  }

  async function copy(url = shareUrl()) {
    try {
      await navigator.clipboard.writeText(url);
      setFeedback({ key, message: "Link copied with your selection." });
    } catch {
      setFeedback({ key, message: "The product link is ready to copy.", fallback: url });
    }
  }

  async function share() {
    setFeedback(undefined);
    const url = shareUrl();
    try {
      await navigator.share({ url });
      setFeedback({ key, message: "Shared your product selection." });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      await copy(url);
    }
  }

  return <div>
    <div className="mp-inline">
      {nativeShare && <button className="button button--outline" type="button" onClick={() => void share()}>
        <Share2 size={17} aria-hidden="true" /> Share product
      </button>}
      <button className="button button--outline" type="button" onClick={() => void copy()}>
        <Link2 size={17} aria-hidden="true" /> Copy product link
      </button>
    </div>
    {result?.fallback && <label className="store-dialog__field" htmlFor={fieldId}>
      Copy this link to share your selection
      <input id={fieldId} type="url" value={result.fallback} readOnly onFocus={event => event.target.select()} />
    </label>}
    <p role="status" className={result && !result.fallback ? undefined : "sr-only"}>
      {result?.message ?? ""}
    </p>
  </div>;
}
