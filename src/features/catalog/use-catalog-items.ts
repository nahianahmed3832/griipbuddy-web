'use client';

import { useEffect, useState } from 'react';
import type { CatalogProduct, Market } from './catalog';

export function useCatalogItems(market: Market, slugs: string[]) {
  const key = JSON.stringify(slugs);
  const [reply, setReply] = useState<{ key: string; products: CatalogProduct[]; failed?: boolean }>();
  const requestKey = market.code + key;

  useEffect(() => {
    const requested = JSON.parse(key) as string[];
    if (!requested.length) return;
    const controller = new AbortController();
    const chunks = Array.from({ length: Math.ceil(requested.length / 30) }, (_, index) => requested.slice(index * 30, (index + 1) * 30));
    Promise.all(chunks.map(async (chunk) => {
      const params = new URLSearchParams([['market', market.code], ...chunk.map((slug) => ['slug', slug])]);
      const response = await fetch('/api/catalog/items?' + params, { signal: controller.signal });
      if (!response.ok) throw new Error('Catalog items unavailable');
      return (await response.json() as { products: CatalogProduct[] }).products;
    })).then((results) => {
      if (!controller.signal.aborted) setReply({ key: requestKey, products: results.flat() });
    }).catch(() => {
      if (!controller.signal.aborted) setReply({ key: requestKey, products: [], failed: true });
    });
    return () => controller.abort();
  }, [key, market.code, requestKey]);

  if (!slugs.length) return { products: [], loading: false, failed: false };
  return { products: reply?.key === requestKey ? reply.products : [], loading: reply?.key !== requestKey, failed: reply?.key === requestKey && reply.failed };
}
