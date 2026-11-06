'use client';

import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import type { CartSnapshot } from '@/features/cart/cart';
import type { CartCommand } from './contracts';
import { accountRequest } from './client';

type Scope = { mode: 'fixture' | 'recovered'; saved: string[]; cart?: CartSnapshot };
type Shopping = Scope & { changeCart: (command: CartCommand) => Promise<boolean>; toggleSaved: (slug: string) => void; error: string };

const AccountShopping = createContext<Shopping | null>(null);

export function AccountShoppingProvider({ scope, children }: { scope: Scope; children: ReactNode }) {
  const [cart, setCart] = useState(scope.cart);
  const [saved, setSaved] = useState(scope.saved);
  const [error, setError] = useState('');
  const queue = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    function recheckRestoredPage(event: PageTransitionEvent) {
      if (event.persisted) window.location.reload();
    }
    window.addEventListener('pageshow', recheckRestoredPage);
    return () => window.removeEventListener('pageshow', recheckRestoredPage);
  }, []);

  function changeCart(command: CartCommand) {
    const task = queue.current.then(async () => {
      setError('');
      const result = await accountRequest<{ cart: CartSnapshot }>('cart', command);
      setCart(result.cart);
      return true;
    }).catch((error: unknown) => {
      setError(error instanceof Error ? error.message : 'Your bag could not be saved.');
      return false;
    });
    queue.current = task;
    return task;
  }

  function toggleSaved(slug: string) {
    queue.current = queue.current.then(async () => {
      setError('');
      const result = await accountRequest<{ saved: string[] }>('wishlist', { slug });
      setSaved(result.saved);
    }).catch((error: unknown) => {
      setError(error instanceof Error ? error.message : 'Your wishlist could not be saved.');
    });
  }

  return <AccountShopping.Provider value={{ mode: scope.mode, cart, saved, changeCart, toggleSaved, error }}>
    {children}
  </AccountShopping.Provider>;
}

export function useAccountShopping() {
  return useContext(AccountShopping);
}
