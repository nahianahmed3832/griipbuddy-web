"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Bell } from "lucide-react";
import { storefrontPath } from "@/config/storefront-path";
import { markets, type MarketId } from "@/config/markets";
import type { VariantWatchOptions } from "@/lib/marketplace/variant-watches";
import { MarketplaceForm } from "./action-form";
import { useMarketplace } from "./session";

const noAlerts: VariantWatchOptions = { backInStock: false, priceDrop: false };

export function VariantWatchForm({ shopperId, variantId, marketId, options = noAlerts }: {
  shopperId: string; variantId: string; marketId: MarketId; options?: VariantWatchOptions;
}) {
  return <MarketplaceForm
    key={`${options.backInStock}/${options.priceDrop}`}
    label="Save product alerts" success="Product alert preferences saved."
    fields={<>
      <label className="mp-remember"><input type="checkbox" name="backInStock" defaultChecked={options.backInStock} /> Back in stock</label>
      <label className="mp-remember"><input type="checkbox" name="priceDrop" defaultChecked={options.priceDrop} /> Price drops</label>
    </>}
    command={form => ({ action: "variant-watch", shopperId, variantId, marketId,
      backInStock: form.has("backInStock"), priceDrop: form.has("priceDrop") })}
  />;
}

export function ProductVariantAlerts({ variantId, variantLabel, marketId, shopperId, options }: {
  variantId: string; variantLabel: string; marketId: MarketId; shopperId?: string; options?: VariantWatchOptions;
}) {
  const account = useMarketplace();
  if (!account) return null;
  const saved = account.shopper?.id === shopperId ? options : undefined;
  return <details className="case-request">
    <summary><Bell size={15} aria-hidden="true" /> Product alerts{(saved?.backInStock || saved?.priceDrop) && " on"}</summary>
    <p>{variantLabel} · {markets[marketId].name}</p>
    {account.shopper ? <>
      <VariantWatchForm key={account.shopper.id} shopperId={account.shopper.id} variantId={variantId} marketId={marketId} options={saved} />
      <Link className="text-link" href="/account/alerts" prefetch={false}>View product alerts</Link>
    </> : <button type="button" className="button button--outline" onClick={account.openAuth}>Sign in for product alerts</button>}
  </details>;
}

export function RefreshVariantAlerts() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return <button type="button" className="button button--outline" disabled={pending}
    onClick={() => startTransition(() => router.refresh())}>{pending ? "Checking alerts…" : "Check for alerts"}</button>;
}

export function WatchedProductLink({ href, marketId, switchMarket, title }: {
  href: string; marketId: MarketId; switchMarket: boolean; title: string;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  if (!switchMarket) return <Link href={href} prefetch={false}>{title}</Link>;
  async function openProduct() {
    setPending(true);
    setError("");
    try {
      const response = await fetch(storefrontPath("/api/marketplace/region"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ region: marketId }),
      });
      if (!response.ok) throw new Error();
      window.location.assign(storefrontPath(href));
    } catch {
      setError("Couldn’t open this shopping market. Try again.");
      setPending(false);
    }
  }
  return <>
    <button className="button button--outline" type="button" disabled={pending} onClick={() => void openProduct()}>{title}</button>
    {error && <p role="alert">{error}</p>}
  </>;
}
