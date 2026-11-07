'use client';

import { Heart } from 'lucide-react';
import { useAccountShopping } from '@/features/account/shopping-scope';
import { updateBrowserList, useBrowserList } from './browser-lists';

const storageKey = 'griipbuddy-storefront-wishlist';

export function useWishlist() {
  const account = useAccountShopping();
  const { items, hydrated } = useBrowserList(storageKey);
  const toggle = (slug: string) => updateBrowserList(storageKey, (previous) => (
    previous.includes(slug) ? previous.filter((entry) => entry !== slug) : [...previous, slug]
  ));
  return {
    saved: account?.saved ?? items, hydrated,
    toggle: account ? account.toggleSaved : toggle,
    readOnly: account !== null && !account.wishlistWritable, error: account?.error,
  };
}

export function WishlistButton({ slug, name, className, showLabel = false }: {
  slug: string; name: string; className?: string; showLabel?: boolean;
}) {
  const { saved, hydrated, toggle, readOnly } = useWishlist();
  const selected = saved.includes(slug);
  return (
    <button type="button" className={className ?? 'wish-button'} aria-label={(selected ? 'Remove ' : 'Save ') + name}
      aria-pressed={selected} disabled={!hydrated || readOnly} onClick={() => toggle(slug)}>
      <Heart size={18} fill={selected ? 'currentColor' : 'none'} aria-hidden />
      {showLabel && (selected ? 'Saved to wishlist' : 'Save to wishlist')}
    </button>
  );
}
