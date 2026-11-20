"use client";

import { useEffect } from "react";
import { storefrontPath } from "@/config/storefront-path";
import { normalizedBrowseUrl } from "@/lib/catalog/browse-url-state";

export function BrowseUrlNormalization({ path, source, query, page }: {
  path: string; source: string; query: string; page: number;
}) {
  useEffect(() => {
    const current = new URL(window.location.href);
    if (current.pathname !== storefrontPath(path)) return;
    // A previous render can commit while a different set of filters is opening.
    const next = normalizedBrowseUrl(current, source, query, page);
    if (next) window.history.replaceState(null, "", next);
  }, [page, path, query, source]);
  return null;
}
