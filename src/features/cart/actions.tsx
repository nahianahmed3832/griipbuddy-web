'use client';

import { Minus, Plus, ShoppingBag } from 'lucide-react';
import { createContext, useContext, useState } from 'react';
import type { CatalogProduct, CatalogVariant } from '@/features/catalog/catalog';
import { lineKey, maxLineQuantity } from './cart';
import { useBagCommands, useCart } from './store';

export const CartActions = createContext<{
  openBag: (trigger: HTMLElement) => void;
  chooseMarket: (trigger: HTMLElement) => void;
} | null>(null);

export function AddToBag({ product, variant, stock, compact = false, showQuantity = false }: {
  product: CatalogProduct; variant?: CatalogVariant; stock: number | null | undefined; compact?: boolean; showQuantity?: boolean;
}) {
  const actions = useContext(CartActions);
  const { lines, hydrated } = useCart();
  const commands = useBagCommands();
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [requested, setRequested] = useState(1);
  const [draft, setDraft] = useState<string>();
  if (!variant?.price) return null;

  const identity = { productId: product.id, variantId: variant.id, slug: product.slug };
  const inBag = lines.find((line) => lineKey(line) === lineKey(identity))?.quantity ?? 0;
  const available = typeof stock === 'number' && stock > 0;
  const remaining = available ? Math.max(0, Math.min(stock, maxLineQuantity) - inBag) : 0;
  const limit = available && remaining === 0;
  const quantity = Math.min(remaining, draft === undefined ? requested : Math.max(1, Math.trunc(Number(draft)) || 1));
  const quantityLocked = !hydrated || pending;
  function changeQuantity(value: number) {
    setRequested(value);
    setDraft(undefined);
  }
  return <div className={'add-to-bag' + (showQuantity ? ' add-to-bag-with-quantity' : '')}>
    {showQuantity && remaining > 1 && <div className="product-quantity" role="group" aria-label="Choose quantity">
      <span>Quantity</span>
      <div className="product-quantity-stepper">
        <button type="button" aria-label="Decrease quantity" disabled={quantityLocked || quantity <= 1}
          onClick={() => changeQuantity(quantity - 1)}><Minus size={16} aria-hidden /></button>
        <input type="number" aria-label="Quantity" min={1} max={remaining} step={1} inputMode="numeric"
          disabled={quantityLocked} value={draft ?? quantity} onChange={(event) => setDraft(event.currentTarget.value)}
          onBlur={() => changeQuantity(quantity)}
          onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
        <button type="button" aria-label="Increase quantity" disabled={quantityLocked || quantity >= remaining}
          onClick={() => changeQuantity(quantity + 1)}><Plus size={16} aria-hidden /></button>
      </div>
      <span className="visually-hidden" role="status">Quantity {quantity}</span>
    </div>}
    <button className={compact ? 'button button-outline' : 'button button-primary'}
      aria-label={compact ? 'Add ' + product.name + ' to bag' : undefined} type="button" disabled={!hydrated || !available || limit || pending} onClick={async (event) => {
      const trigger = event.currentTarget;
      setPending(true);
      const added = await commands.add({ ...identity, quantity, label: product.name });
      setPending(false);
      if (!added) {
        setMessage('The item could not be added. Check your bag and try again.');
        return;
      }
      changeQuantity(1);
      setMessage('Added to your bag.');
      actions?.openBag(trigger);
    }}>
      {!compact && <ShoppingBag size={17} aria-hidden />}{limit ? (compact ? 'In bag' : 'Available quantity in bag') : compact ? '+ Add' : 'Add to bag'}
    </button>
    {message && <span role="status" className="add-to-bag-message">{message}</span>}
  </div>;
}
