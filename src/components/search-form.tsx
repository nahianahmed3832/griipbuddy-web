"use client";

import Form from "next/form";
import Image from "next/image";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Folder, Search, Smartphone, Store, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { formatMoney, type Market } from "@/config/markets";
import { localizedStorePath, withoutRegionalPrefix } from "@/config/regional-path";
import { storefrontPath } from "@/config/storefront-path";
import { loadCatalogSuggestions, type CatalogSuggestions } from "@/lib/catalog/browser-catalog";
import { readSearchQuery, searchQueryMaxLength } from "@/lib/catalog/search-query";
import { trackMeasurement } from "@/lib/measurement/browser";
import { MeasuredCategoryLink, MeasuredProductLink } from "./measurement-observers";
import "./search-form.css";

type SearchScope = "classic" | "store" | "marketplace";
type SuggestionState = { key: string; data?: CatalogSuggestions };
const suggestionDelay = 200;

function SuggestionGroup({ title, children }: { title: string; children: ReactNode }) {
  const heading = useId();
  return <section role="group" aria-labelledby={heading}>
    <h2 id={heading} className="search-suggestions__heading">{title}</h2>
    {children}
  </section>;
}

export function SearchForm({ query = "", scope = "classic", market, regional = false }:
  { query?: string; scope?: SearchScope; market: Market; regional?: boolean }) {
  const [{ value, open, revision }, setField] = useState({ value: query, open: false, revision: 0 });
  const [results, setResults] = useState<SuggestionState>();
  const [active, setActive] = useState<number>();
  const [composing, setComposing] = useState(false);
  const searchRoot = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const popupId = useId();
  const validationId = useId();
  const { id: marketId, locale, currency } = market;
  const parsed = readSearchQuery(value);
  const search = parsed ?? "";
  const key = JSON.stringify([marketId, locale, currency, search, revision]);
  const canSuggest = !composing && search.length >= 2;
  const showing = open && canSuggest;
  const settled = results?.key === key ? results : undefined;
  const matched = showing ? settled?.data : undefined;
  const products = matched?.products ?? [];
  const models = matched?.models ?? [];
  const categories = matched?.categories ?? [];
  const shops = scope === "marketplace" ? matched?.shops ?? [] : [];
  const modelOffset = products.length;
  const categoryOffset = modelOffset + models.length;
  const shopOffset = categoryOffset + categories.length;
  const suggestionCount = shopOffset + shops.length;
  const activeId = showing && active !== undefined && active <= suggestionCount ? `${popupId}-${active}` : undefined;
  const route = (path: string) => regional ? localizedStorePath(path, marketId) : path;
  const marketParams = new URLSearchParams({ market: marketId, lang: locale });
  const searchPath = route("/search");
  const searchHref = `${searchPath}?${new URLSearchParams({ market: marketId, lang: locale, q: search })}`;

  const close = useCallback(() => {
    setField(field => field.open ? { ...field, open: false, revision: field.revision + 1 } : field);
    setActive(undefined);
  }, []);

  function reopen() {
    setField(field => field.open ? field : { ...field, open: true });
  }

  useEffect(() => {
    if (!showing) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const data = await loadCatalogSuggestions(search, { id: marketId, locale, currency }, controller.signal);
        if (!controller.signal.aborted) setResults({ key, data });
      } catch {
        if (!controller.signal.aborted) setResults({ key });
      }
    }, suggestionDelay);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [showing, search, key, marketId, locale, currency]);

  useEffect(() => {
    if (!open) return;
    function dismissOutside(event: PointerEvent) {
      if (event.target instanceof Node && !searchRoot.current?.contains(event.target)) close();
    }
    document.addEventListener("pointerdown", dismissOutside);
    return () => document.removeEventListener("pointerdown", dismissOutside);
  }, [open, close]);

  useEffect(() => {
    if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  function changeValue(next: string) {
    const bounded = next.slice(0, searchQueryMaxLength);
    setField(field => ({ value: bounded, open: true,
      revision: field.revision + Number(readSearchQuery(bounded) !== readSearchQuery(field.value)),
    }));
    setActive(undefined);
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || composing) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      input.current?.focus();
      close();
      return;
    }
    if (event.target !== input.current) return;
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && canSuggest &&
      !event.altKey && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      reopen();
      if (showing && settled) {
        const forward = event.key === "ArrowDown";
        setActive(current => current === undefined ? (forward ? 0 : suggestionCount) :
          (current + (forward ? 1 : suggestionCount)) % (suggestionCount + 1));
      }
    } else if (event.key === "Enter" && activeId) {
      const option = document.getElementById(activeId);
      if (option instanceof HTMLAnchorElement) {
        event.preventDefault();
        option.click();
      }
    } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      setActive(undefined);
    }
  }

  function option(position: number) {
    const id = `${popupId}-${position}`;
    return { id, role: "option", "aria-selected": activeId === id, tabIndex: -1 } as const;
  }

  const submitted = () => {
    close();
    if (search) trackMeasurement({ action: "SEARCH", searchStage: "submitted", marketId, placement: "search-box" });
  };
  const label = scope === "marketplace" ? "Search for items or shops" : "Search products";
  const landmark = scope === "marketplace" ? "Marketplace search" : scope === "store" ? "Store search" : "Product search";
  const message = !settled ? "Finding matches…" : !matched ? "Suggestions are unavailable. You can still run a search."
    : !suggestionCount ? "No suggestions match." : "";

  return <div ref={searchRoot} className={scope === "classic" ? "catalog-search" : "catalog-search mp-search"} onKeyDown={keyboard}
    onBlur={event => { if (event.relatedTarget && !popup.current?.contains(event.relatedTarget)) close(); }}>
    <Form action={searchPath} className="search-form" role="search" aria-label={landmark} onSubmit={event => {
      if (parsed === null) {
        event.preventDefault();
        input.current?.focus();
        return;
      }
      submitted();
    }}>
      <input type="hidden" name="market" value={marketId} />
      <input type="hidden" name="lang" value={locale} />
      <label htmlFor={inputId} className="sr-only">{label}</label>
      <input ref={input} id={inputId} role="combobox" aria-autocomplete="list" aria-expanded={showing}
        aria-controls={showing ? popupId : undefined} aria-activedescendant={activeId}
        aria-invalid={parsed === null || undefined} aria-describedby={parsed === null ? validationId : undefined}
        name="q" type="search" value={value} maxLength={searchQueryMaxLength} autoComplete="off" onFocus={reopen} onPointerDown={reopen}
        onChange={event => changeValue(event.target.value)}
        onCompositionStart={() => { setComposing(true); setActive(undefined); }}
        onCompositionEnd={event => { setComposing(false); changeValue(event.currentTarget.value); }}
        placeholder={scope === "marketplace" ? "Search for anything" : "Search products"} />
      {value && <button type="button" className="search-form__clear mp-search-clear" aria-label="Clear search"
        onClick={() => { changeValue(""); input.current?.focus(); }}><X aria-hidden="true" size={17} /></button>}
      <button type="submit" aria-label="Search"><Search aria-hidden="true" size={21} strokeWidth={2.2} /></button>
    </Form>
    {parsed === null && <p id={validationId} className="search-form__validation" role="status">Edit your search and try again.</p>}
    <div className="search-suggestions" hidden={!showing}>
      <p className={message ? "search-suggestions__message" : "sr-only"} role="status" aria-atomic="true">
        {showing && (message || `${suggestionCount} ${suggestionCount === 1 ? "suggestion" : "suggestions"} available.`)}
      </p>
      <div id={popupId} ref={popup} aria-label="Search suggestions" role="listbox" aria-busy={!settled}>
        {showing && <>
          {!!products.length && <SuggestionGroup title="Products">
            {products.map((hit, index) => <MeasuredProductLink {...option(index)} key={hit.id}
              card={{ id: hit.id, variantId: hit.variantId ?? undefined,
                offerId: hit.variantId && hit.offerEligible ? hit.offerId ?? undefined : undefined,
                priceMinor: hit.offerEligible ? hit.amountMinor : undefined }}
              market={market} context={{ placement: "search-suggestion", position: index + 1 }}
              href={hit.href} prefetch={false} onClick={close}>
              <span className="search-suggestions__image" aria-hidden="true">
                {hit.image && <Image src={storefrontPath(hit.image.src)} alt="" fill sizes="36px" unoptimized />}
              </span>
              <span className="search-suggestions__title"><strong>{hit.name}</strong>
                {hit.match && hit.match.kind !== "text" && <small>{hit.match.label}</small>}
              </span>
              {hit.offerEligible === true && <span className="search-suggestions__price">
                {hit.priceQualifier && <small>{hit.priceQualifier === "from" ? "From" : "Shown option"} </small>}
                {formatMoney(hit.amountMinor, market)}
              </span>}
              {hit.offerEligible === false && <small className="search-suggestions__unavailable">Unavailable in this market</small>}
            </MeasuredProductLink>)}
          </SuggestionGroup>}
          {!!models.length && <SuggestionGroup title="Device models">
            {models.map((hit, index) => <Link {...option(modelOffset + index)} key={hit.id} href={hit.href} prefetch={false} onClick={() => {
              close();
              trackMeasurement({ action: "SEARCH", searchStage: "model-suggestion", marketId, placement: "search-model-suggestion" });
            }}><Smartphone aria-hidden="true" size={18} />{hit.name}</Link>)}
          </SuggestionGroup>}
          {!!categories.length && <SuggestionGroup title="Categories">
            {categories.map((hit, index) => <MeasuredCategoryLink {...option(categoryOffset + index)} key={hit.id}
              href={hit.href} prefetch={false} onClick={close} categoryId={hit.id} marketId={marketId}
              context={{ placement: "search-category-suggestion", position: index + 1 }}>
              <Folder aria-hidden="true" size={18} />{hit.name}
            </MeasuredCategoryLink>)}
          </SuggestionGroup>}
          {!!shops.length && <SuggestionGroup title="Shops">
            {shops.map((hit, index) => <Link {...option(shopOffset + index)} key={hit.id}
              href={`${route(`/shops/${encodeURIComponent(hit.slug)}`)}?${marketParams}`} prefetch={false} onClick={close}>
              <Store aria-hidden="true" size={18} />{hit.name}
            </Link>)}
          </SuggestionGroup>}
          <Link {...option(suggestionCount)} className="search-suggestions__all" href={searchHref} prefetch={false} onClick={submitted}>
            <Search aria-hidden="true" size={18} />Search for {search}
          </Link>
        </>}
      </div>
    </div>
  </div>;
}

export function HeaderSearch({ market, scope, regional }: { market: Market; scope?: SearchScope; regional?: boolean }) {
  const pathname = withoutRegionalPrefix(usePathname());
  const params = useSearchParams();
  const submitted = params.getAll("q");
  const query = pathname === "/search" ? (readSearchQuery(submitted.length > 1 ? submitted : submitted[0]) ?? "") : "";
  return <SearchForm key={`${market.id}:${market.locale}:${query}`} {...{ market, scope, query, regional }} />;
}
