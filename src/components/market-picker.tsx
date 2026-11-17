"use client";

import { ChevronDown, Globe2 } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { changeMarket } from "@/app/actions";
import { getMarket, marketList, type Market } from "@/config/markets";
import { marketPreferenceTarget } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";

export function MarketPicker({ market, marketplace = false, regionalRouting = false }: { market: Market; marketplace?: boolean; regionalRouting?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<Market>(market);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  function openSettings() {
    setDraft(market);
    setError(false);
    dialog.current?.showModal();
  }

  function saveSettings() {
    if (pending) return;
    if (draft.id === market.id) {
      dialog.current?.close();
      return;
    }

    setError(false);
    startTransition(async () => {
      try {
        const changed = marketplace ? (await fetch(storefrontPath("/api/marketplace/region"), {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ region: draft.id }),
        })).ok : await changeMarket(draft.id);
        if (changed) {
          dialog.current?.close();
          if (marketplace && regionalRouting) {
            window.location.assign(marketPreferenceTarget(new URL(window.location.href), draft.id));
          } else if (marketplace) window.location.reload();
        } else {
          setError(true);
        }
      } catch {
        setError(true);
      }
    });
  }

  return (
    <div>
      <button
        className="footer-market"
        ref={trigger}
        type="button"
        aria-label={`Shopping preferences, ${market.name}, ${market.currency}`}
        aria-haspopup="dialog"
        aria-controls="shopping-preferences"
        onClick={openSettings}
      >
        <Globe2 aria-hidden="true" size={17} />
        <span>{market.name}</span>
        {marketplace && <span className="mp-language">English</span>}
        <span className="footer-market__currency">{market.currency}</span>
        <ChevronDown aria-hidden="true" size={13} />
      </button>
      <dialog
        id="shopping-preferences"
        className="store-dialog market-dialog"
        ref={dialog}
        aria-labelledby="shopping-preferences-title"
        onClose={() => trigger.current?.focus()}
        onCancel={(event) => { if (pending) event.preventDefault(); }}
      >
        <h2 id="shopping-preferences-title">{marketplace ? "Update your settings" : "Shopping preferences"}</h2>
        <p className="store-dialog__description">{marketplace ? "Set your shopping region to see available items and prices." : "Your region determines product availability and prices."}</p>
        <form
          className="store-dialog__fields"
          onSubmit={(event) => {
            event.preventDefault();
            saveSettings();
          }}
        >
          <label className="store-dialog__field">
            Region
            <select value={draft.id} disabled={pending} onChange={(event) => setDraft(getMarket(event.target.value))} autoFocus>
              {marketList.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          {marketplace && <div className="store-dialog__field"><span id="market-language-label">Language</span><output aria-labelledby="market-language-label">English</output></div>}
          <div className="store-dialog__field">
            <span id="market-currency-label">Currency</span>
            <output aria-labelledby="market-currency-label">{draft.currencyName} ({draft.currency})</output>
          </div>
          {error && <p className="store-dialog__error" role="alert">Couldn’t save your region. Please try again.</p>}
          <div className="store-dialog__actions">
            <button className="button button--outline" type="button" disabled={pending} onClick={() => dialog.current?.close()}>Cancel</button>
            <button className="button button--primary" type="submit" disabled={pending}>{pending ? "Saving…" : "Save"}</button>
          </div>
        </form>
      </dialog>
      <span className="sr-only" role="status">{`Shopping in ${market.name}, ${market.currency}.`}</span>
    </div>
  );
}
