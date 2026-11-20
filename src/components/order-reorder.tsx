"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { formatMoney, type Market } from "@/config/markets";
import { useCart, useCartActions } from "@/lib/cart/browser";
import { cartLookupBody, cartOfferKey } from "@/lib/cart/model";
import { reorderCatalogByReference, type ReorderLine } from "@/lib/cart/reorder-review";
import { personalizationAvailable } from "@/lib/catalog/personalization";
import { lookupCartPrices } from "./cart-pricing";

type Outcome = { message: string; added?: true };

export function OrderReorder({ lines, market, cartHref }: { lines: readonly ReorderLine[]; market: Market; cartHref: string }) {
  const { addToCart } = useCartActions();
  const { ready, sync } = useCart();
  const active = useRef<AbortController>(null);
  const review = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [results, setResults] = useState<Map<string, Outcome>>();
  const candidates = lines.filter(line => "reference" in line);
  const addedCount = [...(results?.values() ?? [])].filter(result => result.added).length;
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => { if (results) review.current?.focus(); }, [results]);

  async function addReviewedLines() {
    if (!ready || sync === "saving" || active.current || results || !candidates.length) return;
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError(false);
    try {
      const body = cartLookupBody(candidates.map(line => ({ ...line.reference, quantity: line.quantity })));
      const current = reorderCatalogByReference(await lookupCartPrices(body, market.id, controller.signal));
      const outcomes = new Map<string, Outcome>();
      for (const line of lines) {
        if (controller.signal.aborted) return;
        if ("message" in line) {
          outcomes.set(line.id, { message: line.message });
          continue;
        }
        const item = current.get(cartOfferKey(line.reference));
        const offer = item?.offer;
        if (!item || !offer || item.variantId !== line.variantId || offer.id !== line.offerId ||
            offer.currency !== market.currency || offer.marketId !== market.id || offer.stock < line.quantity ||
            !personalizationAvailable(item.personalization, line.personalization)) {
          outcomes.set(line.id, { message: "This purchased quantity or offer is no longer available. Review the exact variant before adding it." });
          continue;
        }
        if (offer.amountMinor !== line.amountMinor) {
          outcomes.set(line.id, { message: `Price changed to ${formatMoney(offer.amountMinor, market)} each. Review the new price on the product page.` });
          continue;
        }
        const added = await addToCart(line.variantId, line.quantity, offer.stock, line.personalization,
          { productId: item.productId, priceMinor: offer.amountMinor }, offer.id).catch(() => false);
        outcomes.set(line.id, added ? { added: true, message: `Added quantity ${line.quantity}.` }
          : { message: "The cart couldn’t confirm this item. Check your cart before trying again." });
      }
      if (!controller.signal.aborted) setResults(outcomes);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      active.current = null;
    }
  }

  return <section className="commerce-panel order-reorder" aria-label="Reorder in your shopping market">
    <h2>Reorder in {market.name}</h2>
    <p>Review the purchased quantities and current prices. Delivery to your address is checked at checkout.</p>
    <div ref={review} tabIndex={-1} aria-label={results ? "Reorder results" : "Items to review"} role="region" aria-busy={busy}>
      {results && <p role="status">{addedCount} of {lines.length} purchased lines added to your cart.</p>}
      <dl>
        {lines.map(line => <div key={line.id}>
          <dt><strong>{line.productName} · {line.sku}</strong></dt>
          <dd>{results?.get(line.id)?.message ?? ("message" in line ? line.message
            : `${line.quantity} × ${formatMoney(line.amountMinor, market)} each`)}</dd>
          {"personalization" in line && line.personalization && <dd>Personalization: {line.personalization}</dd>}
        </div>)}
      </dl>
    </div>
    {error && <p role="alert">Current offers couldn’t be checked. Try again to review the reorder.</p>}
    {results ? <Link className="button button--outline" href={cartHref}>View your cart</Link>
      : candidates.length > 0 && <button type="button" className="button button--primary"
        disabled={!ready || busy || sync === "saving"} onClick={() => void addReviewedLines()}>
        {busy ? "Checking and adding items…" : "Add available items to cart"}
      </button>}
  </section>;
}
