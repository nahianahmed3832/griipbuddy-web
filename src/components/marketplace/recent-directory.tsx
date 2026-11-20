"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatMoney, type Market } from "@/config/markets";
import { storefrontPath } from "@/config/storefront-path";
import { chooseRecommendations } from "@/lib/catalog/recommendation-preference-client";
import { useRecentlyViewedIds } from "./recent";

type Item = { id: string; name: string; image: { src: string; alt: string } | null; priceMinor: number; currency: string; href: string };
type Result = { key: string; items?: Item[] };

export function RecentDirectory({ market }: { market: Market }) {
  const { choice, ids } = useRecentlyViewedIds(market.id);
  const query = new URLSearchParams({ market: market.id, lang: market.locale });
  for (const id of ids) query.append("product", id);
  const key = query.toString();
  const [state, setState] = useState<Result>();
  const [retry, setRetry] = useState(0);
  const active = choice === "on" && ids.length > 0;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    void fetch(storefrontPath(`/api/catalog/recent?${key}`), { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Unavailable");
        const data = await response.json() as { items: Item[] };
        if (!controller.signal.aborted) setState({ key, items: data.items });
      }).catch(() => { if (!controller.signal.aborted) setState({ key }); });
    return () => controller.abort();
  }, [active, key, retry]);
  if (choice !== "on") return <p>Recently viewed items appear when you enable browsing recommendations.</p>;
  if (!active) return <p>No recent products in {market.name}.</p>;
  if (state?.key !== key) return <p role="status">Checking recent products…</p>;
  if (!state.items) return <p role="status">Recent products could not be loaded.{" "}
    <button className="text-link" type="button" onClick={() => setRetry(count => count + 1)}>Try again</button></p>;
  const items = state.items.filter(item => item.currency === market.currency);
  return <>
    <button type="button" className="button button--outline" onClick={() => void chooseRecommendations("reset", market.id)}>Clear history</button>
    {!items.length && <p>No recent products are available in {market.name}.</p>}
    <ul className="product-grid">{items.map(item => <li key={item.id}>
      <Link className="product-card" href={item.href} prefetch={false}>
        <div className="product-card__image">{item.image && <Image alt={item.image.alt} src={storefrontPath(item.image.src)}
          fill sizes="(max-width: 730px) 48vw, 260px" />}</div>
        <h2>{item.name}</h2><p className="product-card__price">{formatMoney(item.priceMinor, market)}</p>
      </Link>
    </li>)}</ul>
  </>;
}
