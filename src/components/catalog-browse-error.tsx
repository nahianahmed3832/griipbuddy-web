"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { localizedStorePath, regionalMarket } from "@/config/regional-path";
import { useCartPricing } from "./cart-pricing";
import { EmptyState } from "./store-ui";

export default function CatalogBrowseError({
  retry, title = "We couldn’t load this catalog page", description = "Try loading the page again, or continue browsing from the shop.",
}: { retry: () => void; title?: string; description?: string }) {
  const { market } = useCartPricing();
  const path = regionalMarket(usePathname()) ? localizedStorePath("/shop", market.id) : "/shop";
  const shop = `${path}?${new URLSearchParams({ market: market.id, lang: market.locale })}`;
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.focus(); }, []);
  return <div className="shell inner-page" tabIndex={-1} ref={panel}>
    <EmptyState heading="h1" title={title} description={description}>
      <button className="button button--primary" type="button" onClick={retry}>Try again</button>
      <Link href={shop} className="button button--outline" prefetch={false}>Browse all products</Link>
    </EmptyState>
  </div>;
}
