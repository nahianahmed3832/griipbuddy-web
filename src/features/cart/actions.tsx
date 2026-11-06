'use client';

import { ShoppingBag } from 'lucide-react';
import { createContext, useContext, useState } from 'react';
import type { CatalogProduct, CatalogVariant } from '@/features/catalog/catalog';
import { lineKey, maxLineQuantity } from './cart';
import { useBagCommands, useCart } from './store';

export const CartActions = createContext<{
  openBag: (trigger: HTMLElement) => void;
  chooseMarket: (trigger: HTMLElement) => void;
} | null>(null);

export function AddToBag({ product, variant, stock, compact = false }: {
  product: CatalogProduct; variant?: CatalogVariant; stock: number | null | undefined; compact?: boolean;
}) {
  const actions = useContext(CartActions);
  const { lines, hydrated } = useCart();
  const commands = useBagCommands();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  if (!variant?.price) return null;

  const identity = { productId: product.id, variantId: variant.id, slug: product.slug };
  const quantity = lines.find((line) => lineKey(line) === lineKey(identity))?.quantity ?? 0;
  const available = typeof stock === 'number' && stock > 0;
  const limit = available && quantity >= Math.min(stock, maxLineQuantity);
  return <div className="add-to-bag">
    <button className={compact ? 'button button-outline' : 'button button-primary'}
      aria-label={compact ? 'Add ' + product.name + ' to bag' : undefined} type="button" disabled={!hydrated || !available || limit || pending} onClick={async (event) => {
      const trigger = event.currentTarget;
      setPending(true);
      const added = await commands.add({ ...identity, quantity: 1, label: product.name });
      setPending(false);
      if (!added) {
        setMessage('The item could not be added. Check your bag and try again.');
        return;
      }
      setMessage('Added to your bag.');
      actions?.openBag(trigger);
    }}>
      {!compact && <ShoppingBag size={17} aria-hidden />}{limit ? (compact ? 'In bag' : 'Available quantity in bag') : compact ? '+ Add' : 'Add to bag'}
    </button>
    {message && <span role="status" className="add-to-bag-message">{message}</span>}
  </div>;
}
