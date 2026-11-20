"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { EmptyState } from "./store-ui";

export default function CatalogBrowseError({ retry }: { retry: () => void }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => { panel.current?.focus(); }, []);
  return <div className="shell inner-page" tabIndex={-1} ref={panel}>
    <EmptyState title="We couldn’t load this catalog page" description="Try loading the page again, or continue browsing from the shop.">
      <button className="button button--primary" type="button" onClick={retry}>Try again</button>
      <Link href="/shop" className="button button--outline">Browse all products</Link>
    </EmptyState>
  </div>;
}
