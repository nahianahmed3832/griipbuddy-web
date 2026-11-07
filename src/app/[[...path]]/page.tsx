import { hostedCatalogPreview, publicBuild } from '@/features/public-build';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { categoryAt, categoryHref, collections, flattenCategories, marketHref, productHref, type Market } from '@/features/catalog/catalog';
import { canonicalFor, canonicalOrigin } from '@/features/catalog/seo';
import { accountMode } from '@/features/account/config';
import { Comparison } from '@/features/catalog/compare';
import { DiscoveryPage, discoveryPages, type DiscoveryPageKey } from '@/features/discovery/discovery-page';
import { catalogNavigation, catalogProduct } from '@/features/catalog/data';
import { CatalogListing } from '@/features/catalog/listing';
import { ProductPage } from '@/features/catalog/product-page';
import { WishlistPage } from '@/features/catalog/saved-products';
import type { CatalogParams } from '@/features/catalog/browse';
import { Homepage } from '@/features/home/homepage';
import { contentMedia, contentRows, siteContent, text } from '@/features/home/content';
import { resolveMarket } from '@/features/markets/resolve';
import { CartView } from '@/features/cart/cart-view';
import { checkoutPaused, methodsFor } from '@/features/checkout/config';
import { integratedCheckout, integratedMethods } from '@/features/checkout/integrated';
import { currentAccount } from '@/features/account/session';
import { OrderPage } from '@/features/checkout/order-page';
import { CustomerPage } from '@/features/account/account-page';

import { InformationPage, ProfilePage, information, type InformationPageKey } from '@/features/information/pages';

function PageFrame({ market, title, subtitle, checkout = false, shopping = false, children }: { market: Market; title: string; subtitle?: string; checkout?: boolean; shopping?: boolean; children?: ReactNode }) {
  return (
    <div className={'container interior' + (checkout ? ' checkout-page' : '')}>
      <Link className="back-link" href={marketHref(market, checkout ? '/cart' : '/')}><ArrowLeft size={16} aria-hidden /> {checkout ? 'Shopping bag' : 'Home'}</Link>
      {shopping && <nav className="purchase-progress" aria-label="Purchase progress">
        <ol>
          <li>{checkout ? <Link href={marketHref(market, '/cart')}>1. Bag</Link> : <span aria-current="step">1. Bag</span>}</li>
          <li><span aria-current={checkout ? 'step' : undefined}>2. Checkout</span></li>
        </ol>
      </nav>}
      <div className="interior-heading"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      {children}
    </div>
  );
}

type PageProps = { params: Promise<{ path?: string[] }>; searchParams: Promise<CatalogParams> };

async function resolvePath(path: string[]) {
  const { markets, categories } = await catalogNavigation();
  const { market, explicit } = await resolveMarket(markets, path[0]);
  const [section, ...rest] = explicit ? path.slice(1) : path;
  return { market, categories, section, rest, canonical: explicit && path[0] === market.prefix.slice(1) };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const resolved = await resolvePath((await params).path ?? []);
  const defaults = await defaultMetadata(resolved);
  const { market, section, rest } = resolved;
  if (section && !['product','category','collections','products', ...Object.keys(discoveryPages), ...Object.keys(information)].includes(section)) return defaults;
  const path = '/' + (section ? [section, ...rest].join('/') : '');
  const canonicalPath = marketHref(market, path);
  const entries = contentRows((await siteContent()).seo);
  const saved = entries.find(row => row.path === canonicalPath) ?? entries.find(row => row.path === path);
  if (!saved) return defaults;
  const title = text(saved.title) || (typeof defaults.title === 'string' ? defaults.title : undefined);
  const description = text(saved.description) || defaults.description || undefined;
  const image = contentMedia(saved.image);
  const share = image?.startsWith('/') ? canonicalFor(image).alternates?.canonical : image;
  return { ...defaults, title, description, openGraph: { ...defaults.openGraph, title, description, ...(typeof share === 'string' ? { images: [share] } : {}) } };
}

async function defaultMetadata({ market, categories, section, rest }: Awaited<ReturnType<typeof resolvePath>>): Promise<Metadata> {
  if (section === 'product' && rest.length === 1) {
    const product = await catalogProduct(market, rest[0]);
    if (product) {
      const description = product.description.slice(0, 160) || undefined;
      const image = product.images[0] ?? product.variants.find(variant => variant.images.length)?.images[0];
      const origin = canonicalOrigin();
      const share = image?.startsWith('/') ? origin && origin + image : image;
      return { title: product.name, description, ...canonicalFor(productHref(market, product.slug)),
        openGraph: { title: product.name, description, ...(share && { images: [share] }) } };
    }
  }
  if (section === 'category') {
    const category = categoryAt(categories, rest);
    if (category) return { title: category.label, description: category.description || undefined, ...canonicalFor(categoryHref(market, category.path)) };
  }
  if (section === 'collections') {
    const collection = collections.find((entry) => entry.id === rest[0]);
    if (collection) return { title: collection.label, description: collection.description, ...canonicalFor(marketHref(market, '/collections/' + collection.id)) };
  }
  if (section && !rest.length && Object.hasOwn(discoveryPages, section)) {
    const { title, description } = discoveryPages[section as DiscoveryPageKey];
    return { title, description, ...canonicalFor(marketHref(market, '/' + section)) };
  }
  if (section === 'compare') return { title: 'Compare products' };
  if (section === 'search') return { title: 'Search' };
  if (section === 'products') return { title: 'Shop all', ...canonicalFor(marketHref(market, '/products')) };
  if (section === 'account' || section === 'login') return { title: 'My account' };
  if (section === 'profile') return { title: 'Profile' };
  if (section === 'cart') return { title: 'Shopping bag' };
  if (section === 'wishlist') return { title: 'Wishlist' };
  if (section === 'checkout') return { title: 'Review checkout' };
  if (section === 'order') return { title: 'Order details', referrer: 'no-referrer' };
  if (section && !rest.length && Object.hasOwn(information, section)) {
    const { title, description } = information[section as InformationPageKey];
    return { title, description, ...canonicalFor(marketHref(market, '/' + section)) };
  }
  if (!section) return canonicalFor(marketHref(market));
  return {};
}

export default async function StorefrontPage({ params, searchParams }: PageProps) {
  const { market, categories, section, rest, canonical } = await resolvePath((await params).path ?? []);
  const query = await searchParams;

  if (!canonical) {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) search.append(key, item);
    }
    const destination = marketHref(market, '/' + (section ? [section, ...rest].map(encodeURIComponent).join('/') : ''));
    redirect(destination + (search.size ? '?' + search : ''));
  }
  if (!section) return <Homepage market={market} categories={categories} />;
  if (section === 'category' && rest.length && rest.length <= 4) {
    const category = categoryAt(categories, rest);
    if (!category) notFound();
    return <CatalogListing market={market} categories={categories} category={category} title={category.label} description={category.description}
      path={'/category/' + category.path.map(encodeURIComponent).join('/')} params={query} />;
  }
  if (section === 'collections' && rest.length === 1) {
    const collection = collections.find((entry) => entry.id === rest[0]);
    if (!collection) notFound();
    return <CatalogListing market={market} categories={categories} collection={collection.id} title={collection.label}
      description={collection.description} path={'/collections/' + collection.id} params={query} />;
  }
  if (section === 'product' && rest.length === 1) {
    const product = await catalogProduct(market, rest[0]);
    if (!product) notFound();
    if (product.slug !== rest[0]) redirect(productHref(market, product.slug));
    return <ProductPage product={product} market={market} categories={categories}
      requestedVariant={typeof query.variant === 'string' ? query.variant : undefined} />;
  }
  if (section === 'products' && rest.length === 1) {
    const match = flattenCategories(categories).filter((category) => category.slug === rest[0]);
    if (match.length === 1) redirect(categoryHref(market, match[0].path));
    notFound();
  }
  if (section === 'account' || section === 'login') {
    if (!accountMode()) redirect(marketHref(market, '/products'));
    if (section === 'login' && rest.length) notFound();
    return <CustomerPage market={market} path={rest} login={section === 'login'}
      googleFailed={query.google === 'failed'} requestedOrder={typeof query.order === 'string' ? query.order : undefined}
      returnTo={typeof query.next === 'string' ? query.next : undefined} />;
  }
  if (section === 'order' && rest.length === 1) {
    if (publicBuild()) notFound();
    return <OrderPage id={rest[0]} market={market} />;
  }
  if (rest.length) notFound();

  if (section === 'products' || section === 'search') {
    return <CatalogListing market={market} categories={categories} title={section === 'search' ? 'Search' : 'Shop all'}
      path={'/' + section} params={query} search={section === 'search'} />;
  }
  if (Object.hasOwn(discoveryPages, section)) return <DiscoveryPage market={market} page={section as DiscoveryPageKey} />;
  if (section === 'compare') return <PageFrame market={market} title="Compare products"
    subtitle="Review prices and product details side by side. Your selection stays on this device."><Comparison market={market} /></PageFrame>;
  if (section === 'wishlist') return <PageFrame market={market} title="Wishlist"><WishlistPage market={market} /></PageFrame>;
  if (section === 'cart' || section === 'checkout') {
    const checkout = section === 'checkout';
    const integrated = checkout && !publicBuild() && integratedCheckout();
    const signIn = integrated && !await currentAccount();
    const methods = checkout && !signIn && !publicBuild() ? integrated ? await integratedMethods(market.code) : methodsFor(market.code) : undefined;
    const checkoutIntro = methods?.length ? 'Confirm delivery and payment for your test order.'
      : signIn ? 'Sign in to confirm delivery and payment for your test order.'
        : integrated ? 'Checkout is unavailable for this delivery market. You can still review your bag.'
          : hostedCatalogPreview() ? 'Review catalog prices and stock. Shipping and payment are simulated on this development site.'
            : 'Review the current prices, availability and delivery estimate before running a simulation.';
    return <PageFrame market={market} title={checkout ? 'Review checkout' : 'Shopping bag'} checkout={checkout} shopping
      subtitle={checkout ? checkoutIntro : undefined}>
      {signIn && <Link className="button button-primary" href={marketHref(market, '/login?next=%2Fcheckout')}>Sign in to check out</Link>}
      <CartView key={market.code + ':' + section} market={market} view={checkout ? 'checkout' : 'page'} methods={methods}
        paused={checkout && checkoutPaused()} allowSimulation={!integrated} preview={hostedCatalogPreview()} />
    </PageFrame>;
  }
  if (section === 'profile') return <ProfilePage market={market} accountsEnabled={Boolean(accountMode())}
    signedIn={Boolean(await currentAccount())} />;
  if (Object.hasOwn(information, section)) return <InformationPage market={market} slug={section as InformationPageKey} />;
  notFound();
}
