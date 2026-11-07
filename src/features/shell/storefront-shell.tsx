'use client';

import { ArrowRight, ArrowUpRight, Check, ChevronDown, Globe, Heart, House, LocateFixed, Menu, ShoppingBag, UserRound, Zap } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useRef, useState, type ReactNode } from 'react';
import { categoryHref, collections, marketForSegment, marketHref, type Category, type Market } from '@/features/catalog/catalog';
import { SearchBox } from '@/features/catalog/search-box';
import { CatalogImage } from '@/features/catalog/catalog-image';
import { CartActions } from '@/features/cart/actions';
import { CartView } from '@/features/cart/cart-view';
import { useCart } from '@/features/cart/store';
import { discoveryLinks } from '@/features/discovery/contracts';
import { Footer } from './footer';
import { PanelDialog } from './panel-dialog';

type Panel = 'market' | 'browse' | 'bag';

type ShellProps = { children: ReactNode; markets: Market[]; categories: Category[]; signedIn: boolean; accountsEnabled: boolean; announcement?: string; preview?: boolean };

function BrowseCategory({ category, market, close }: { category: Category; market: Market; close: () => void }) {
  const href = categoryHref(market, category.path);
  if (!category.children.length) return <Link href={href} onClick={close}>{category.label}<ArrowUpRight size={17} aria-hidden /></Link>;
  return <details className="browse-category">
    <summary>{category.label}<ChevronDown size={16} aria-hidden /></summary>
    <div>
      <Link href={href} onClick={close}>Shop all {category.label.toLowerCase()}<ArrowUpRight size={17} aria-hidden /></Link>
      {category.children.map((child) => <BrowseCategory key={child.id} category={child} market={market} close={close} />)}
    </div>
  </details>;
}

function Chrome({ pathname, markets, categories, signedIn, accountsEnabled, announcement, preview, children }: ShellProps & { pathname: string }) {
  const [segment, ...rest] = pathname.split('/').filter(Boolean);
  const explicitMarket = marketForSegment(markets, segment);
  const market = explicitMarket ?? markets.find((entry) => entry.code === 'INTL') ?? markets[0];
  const localPath = explicitMarket ? '/' + rest.join('/') : pathname;
  const [panel, setPanel] = useState<Panel | null>(null);
  const [marketPending, setMarketPending] = useState(false);
  const [marketError, setMarketError] = useState(false);
  const { lines } = useCart();
  const count = lines.reduce((sum, line) => sum + line.quantity, 0);
  const countLabel = count + (count === 1 ? ' item' : ' items');
  const [mega, setMega] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const router = useRouter();
  const activeCategory = categories.find((category) => category.id === mega);

  function open(next: Panel, trigger: HTMLElement) {
    opener.current = trigger;
    setMega(null);
    setMarketError(false);
    setPanel(next);
  }

  function close() {
    setPanel(null);
    requestAnimationFrame(() => opener.current?.focus());
  }

  async function changeMarket(next: Market | null) {
    if (marketPending) return;
    setMarketPending(true);
    setMarketError(false);
    try {
      const response = await fetch('/api/markets/preference', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ market: next?.code ?? null }),
      });
      if (!response.ok) throw new Error('Preference unavailable');
      const query = new URLSearchParams(window.location.search);
      if (!next || next.currency !== market.currency) {
        query.delete('min');
        query.delete('max');
        query.delete('page');
      }
      query.delete('batch');
      const suffix = query.size ? '?' + query : '';
      close();
      if (next) router.push(marketHref(next, localPath) + suffix);
      else window.location.assign(localPath + suffix);
    } catch {
      setMarketError(true);
    } finally {
      setMarketPending(false);
    }
  }

  return (
    <CartActions.Provider value={{ openBag: (trigger) => open('bag', trigger), chooseMarket: (trigger) => open('market', trigger) }}>
      <a href="#main-content" className="skip-link">Skip to content</a>
      <div className="announcement">
        <Link href={marketHref(market, '/collections/new-arrivals')}>{announcement || 'Discover what’s new'} <ArrowRight size={14} aria-hidden /></Link>
      </div>
      <header className="header" onKeyDown={(event) => {
        if (event.key === 'Escape' && mega) {
          event.preventDefault();
          document.getElementById('nav-' + mega)?.focus();
          setMega(null);
        }
      }}>
        <div className="container header-inner">
          <button type="button" className="icon-button browse-trigger" aria-label="Browse categories" onClick={(event) => open('browse', event.currentTarget)}><Menu aria-hidden /></button>
          <Link className="brand" href={marketHref(market)} aria-label="GriipBuddy home" onClick={() => setMega(null)}>
            <Image src="/brand/griipbuddy-wordmark.webp" width={180} height={45} alt="GriipBuddy" priority />
          </Link>
          <div className="header-find">
            <button type="button" className="icon-button header-browse" aria-label="Browse categories" onClick={(event) => open('browse', event.currentTarget)}><Menu aria-hidden /></button>
            <SearchBox market={market} categories={categories} style="header" onFocus={() => setMega(null)} />
          </div>
          <div className="header-utilities">
            <button type="button" className="market-trigger" aria-label={'Choose country, current market ' + market.name}
              onClick={(event) => open('market', event.currentTarget)}><Globe size={16} aria-hidden /><span>{market.code}<span className="market-currency"> / {market.currency}</span></span><ChevronDown size={11} aria-hidden /></button>
            {accountsEnabled && <Link className="icon-button header-account" aria-label="Account" href={marketHref(market, signedIn ? '/account' : '/login')} onClick={() => setMega(null)}><UserRound aria-hidden /></Link>}
            <Link className="icon-button desktop-utility" aria-label="Wishlist" href={marketHref(market, '/wishlist')} onClick={() => setMega(null)}><Heart aria-hidden /></Link>
            <button type="button" className="icon-button desktop-utility bag-trigger"
              aria-label={count ? 'Shopping bag, ' + countLabel : 'Shopping bag'}
              onClick={(event) => open('bag', event.currentTarget)}><ShoppingBag aria-hidden />
              {count > 0 && <span aria-hidden className="bag-count">{count}</span>}
            </button>
          </div>
        </div>
        <nav className="container desktop-nav" aria-label="Main navigation">
          <Link className="nav-shop-all" aria-current={localPath === '/products' ? 'page' : undefined} href={marketHref(market, '/products')} onClick={() => setMega(null)}>Shop all</Link>
          <Link className="nav-featured" aria-current={localPath === '/collections/new-arrivals' ? 'page' : undefined} href={marketHref(market, '/collections/new-arrivals')} onClick={() => setMega(null)}>New Arrivals</Link>
          {categories.map((category) => (
            <button type="button" key={category.id} id={'nav-' + category.id} aria-expanded={mega === category.id}
              aria-controls={mega === category.id ? 'category-mega-menu' : undefined}
              data-current={localPath === '/category/' + category.slug || localPath.startsWith('/category/' + category.slug + '/') || undefined}
              onClick={() => setMega(mega === category.id ? null : category.id)}>
              {category.label}<ChevronDown size={12} aria-hidden />
            </button>
          ))}
          {discoveryLinks.map(({ path, label }) => <Link key={path} className={path === '/deals' ? 'nav-deals' : undefined}
            aria-current={localPath === path ? 'page' : undefined} href={marketHref(market, path)} onClick={() => setMega(null)}>
            {path === '/deals' && <Zap size={14} aria-hidden />}{label}
          </Link>)}
        </nav>
        {activeCategory && (
          <>
            <div className="mega-underlay" aria-hidden onClick={() => setMega(null)} />
            <nav id="category-mega-menu" className="mega-menu" aria-label={activeCategory.label + ' categories'}>
              <div className="container mega-inner">
                <div><p className="eyebrow">EXPLORE</p><h2>{activeCategory.label}</h2><p>{activeCategory.description}</p>
                  <Link className="text-link" href={categoryHref(market, activeCategory.path)} onClick={() => setMega(null)}>
                    Shop all {activeCategory.label.toLowerCase()} <ArrowUpRight size={16} aria-hidden />
                  </Link>
                </div>
                <div className="mega-links">
                  <p className="eyebrow">{activeCategory.children.length ? 'SUBCATEGORIES' : 'DISCOVER THE EDIT'}</p>
                  {activeCategory.children.length
                    ? activeCategory.children.map((category) => <Link key={category.id} href={categoryHref(market, category.path)} onClick={() => setMega(null)}>{category.label}</Link>)
                    : collections.map((collection) => <Link key={collection.id} href={marketHref(market, '/collections/' + collection.id)} onClick={() => setMega(null)}>{collection.label}</Link>)}

                </div>
                {activeCategory.image && <div className="mega-image">
                  <CatalogImage src={activeCategory.image} alt="" fill sizes="320px" />
                </div>}
              </div>
            </nav>
          </>
        )}
      </header>
      <main id="main-content" className="storefront-route" tabIndex={-1}>{children}</main>
      <Footer market={market} categories={categories} geoAttribution={preview} accountsEnabled={accountsEnabled} onMarket={(trigger) => open('market', trigger)} />
      <nav className="mobile-nav" aria-label="Mobile navigation">
        <Link href={marketHref(market)} aria-current={localPath === '/' ? 'page' : undefined}><House aria-hidden /><span>Home</span></Link>
        <Link className="bag-trigger" href={marketHref(market, '/cart')} aria-label={count ? 'Cart, ' + countLabel : 'Cart'}
          aria-current={localPath === '/cart' || localPath === '/checkout' ? 'page' : undefined}><ShoppingBag aria-hidden /><span>Cart</span>
          {count > 0 && <span aria-hidden className="bag-count">{count}</span>}
        </Link>
        <Link href={marketHref(market, '/profile')} aria-current={/^\/(profile|account|login|wishlist)(\/|$)/.test(localPath) ? 'page' : undefined}>
          <UserRound aria-hidden /><span>Profile</span>
        </Link>
      </nav>
      {panel === 'bag' && <PanelDialog title="Shopping bag" close={close}>
        <CartView market={market} view="drawer" onNavigate={close} preview={preview} />
      </PanelDialog>}
      {panel === 'market' && (
        <PanelDialog title="Choose your country" close={close} placement="market">
          <div className="market-current">
            <Globe size={21} aria-hidden />
            <div><small>CURRENT MARKET</small><strong>{market.name} · {market.currency}</strong></div>
          </div>
          <p className="drawer-lede">Your market sets the catalog and currency. Delivery is checked in your cart.</p>
          <button type="button" className="button button-outline market-auto" disabled={marketPending} onClick={() => void changeMarket(null)}>
            <LocateFixed size={17} aria-hidden /> Use automatic location
          </button>
          <div className="market-options" aria-label="Available markets">
            {markets.map((option) => (
              <button key={option.code} type="button" aria-pressed={market.code === option.code} disabled={marketPending} onClick={() => void changeMarket(option)}>
                <span>{option.name}<small>{option.catalogCountry ? option.catalogCountry + ' storefront assortment' : option.currency}</small></span>
                {market.code === option.code ? <Check size={19} aria-hidden /> : <span className="market-option-code">{option.code}</span>}
              </button>
            ))}
          </div>
          {marketError && <p role="status" className="bag-line-error">Could not save your selection. Try again.</p>}
        </PanelDialog>
      )}
      {panel === 'browse' && (
        <PanelDialog title="Browse" close={close}>
          <div className="drawer-links">
            <p className="eyebrow">SHOP BY CATEGORY</p>
            <Link href={marketHref(market, '/products')} onClick={close}>Shop all<ArrowUpRight size={17} aria-hidden /></Link>
            {categories.map((category) => (
              <BrowseCategory key={category.id} category={category} market={market} close={close} />
            ))}
          </div>
          <div className="drawer-links">
            <p className="eyebrow">DISCOVER</p>
            {discoveryLinks.map(({ path, label }) => <Link key={path} href={marketHref(market, path)} onClick={close}>{label}<ArrowUpRight size={17} aria-hidden /></Link>)}
            {collections.map((collection) => (
              <Link key={collection.id} href={marketHref(market, '/collections/' + collection.id)} onClick={close}>{collection.label}<ArrowUpRight size={17} aria-hidden /></Link>
            ))}
            {accountsEnabled && <Link href={marketHref(market, signedIn ? '/account' : '/login')} onClick={close}>Account<UserRound size={17} aria-hidden /></Link>}
          </div>
        </PanelDialog>
      )}
    </CartActions.Provider>
  );
}

export function StorefrontShell(props: ShellProps) {
  const pathname = usePathname();
  return <Chrome key={pathname} pathname={pathname} {...props} />;
}
