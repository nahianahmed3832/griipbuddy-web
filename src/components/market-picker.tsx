"use client";

import { ChevronDown, Globe2 } from "lucide-react";
import { useRef, useState, useTransition } from "react";
import { changeShoppingPreferences } from "@/app/actions";
import type { Market } from "@/config/markets";
import { storefrontBasePath, storefrontPath } from "@/config/storefront-path";

type MarketChoice = Market & { languages: readonly string[] };

function languageName(locale: string) {
  return new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale;
}

export function MarketPicker({ market, options, marketplace = false }: {
  market: Market; options: readonly MarketChoice[]; marketplace?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [draft, setDraft] = useState<MarketChoice>(() => options.find(item => item.id === market.id) ?? { ...market, languages: [market.locale] });
  const [locale, setLocale] = useState(market.locale);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  function openSettings() {
    setDraft(options.find(item => item.id === market.id) ?? { ...market, languages: [market.locale] });
    setLocale(market.locale);
    setError(false);
    dialog.current?.showModal();
  }

  function saveSettings() {
    if (pending) return;
    if (draft.id === market.id && locale === market.locale) {
      dialog.current?.close();
      return;
    }

    setError(false);
    startTransition(async () => {
      try {
        const { pathname, search, hash } = window.location;
        const route = pathname.slice(storefrontBasePath.length) || "/";
        const input = { marketId: draft.id, locale, fromMarketId: market.id, fromLocale: market.locale, path: route + search + hash };
        let href;
        if (marketplace) {
          const response = await fetch(storefrontPath("/api/marketplace/region"), {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input),
          });
          href = response.ok && (await response.json()).href;
        } else {
          href = await changeShoppingPreferences(input);
        }
        if (typeof href === "string") window.location.assign(href);
        else setError(true);
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
        {marketplace && <span className="mp-language">{new Intl.DisplayNames(["en"], { type: "language", languageDisplay: "standard" }).of(new Intl.Locale(market.locale).language)}</span>}
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
        <p className="store-dialog__description">Your region determines product availability and prices. Language controls catalog text.</p>
        <form
          className="store-dialog__fields"
          onSubmit={(event) => {
            event.preventDefault();
            saveSettings();
          }}
        >
          <label className="store-dialog__field">
            Region
            <select value={draft.id} disabled={pending} onChange={(event) => {
              const region = options.find(option => option.id === event.target.value);
              if (!region) return;
              setDraft(region);
              if (!region.languages.includes(locale)) setLocale(region.locale);
            }} autoFocus>
              {options.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <label className="store-dialog__field">
            Language
            <select value={locale} disabled={pending} onChange={event => setLocale(event.target.value)}>
              {draft.languages.map(tag => <option key={tag} value={tag}>{languageName(tag)}</option>)}
            </select>
          </label>
          <div className="store-dialog__field">
            <span id="market-currency-label">Currency</span>
            <output aria-labelledby="market-currency-label">{draft.currencyName} ({draft.currency})</output>
          </div>
          {error && <p className="store-dialog__error" role="alert">Couldn’t save your shopping preferences. Please try again.</p>}
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
