import { ArrowRight, ArrowUpRight, Grid2X2, Sparkles, Ticket, Users, Zap } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { compareProducts, inCollection } from '@/features/catalog/browse';
import { categoryHref, collections, marketHref, productHref, type CatalogProduct, type Category, type Market } from '@/features/catalog/catalog';
import { catalogSample, withAvailability } from '@/features/catalog/data';
import { CatalogGrid } from '@/features/catalog/listing';
import { record, rows } from '@/features/catalog/api';
import { ShoppingHistory } from '@/features/catalog/saved-products';
import { discoveryLinks } from '@/features/discovery/contracts';
import { contentMedia, contentPath, contentRows, siteContent, text } from './content';

function Hero({ market, content }: { market: Market; content: Record<string, unknown> }) {
  const button = record(content.button);
  const video = contentMedia(content.video_url);
  const cover = contentMedia(content.thumbnail_url);
  const destination = contentPath(button.redirect_route);
  return (
    <section className="market-hero" aria-labelledby="hero-title">
      <div className="market-hero-copy">
        <p className="eyebrow"><Sparkles size={15} aria-hidden /> THE GRIIPBUDDY EDIT</p>
        <h1 id="hero-title">{text(content.title) || <>Good finds.<br /><span>Great grip.</span></>}</h1>
        <p>Smart tech, everyday style and little upgrades for wherever life takes you.</p>
        <div className="market-hero-actions">
          <Link className="button button-primary" href={marketHref(market, button.enabled === true && destination ? destination : '/collections/new-arrivals')}>
            {(button.enabled === true && destination ? text(button.text) : '') || 'Shop new arrivals'} <ArrowRight size={17} aria-hidden />
          </Link>
          <Link className="text-link" href={marketHref(market, '/products')}>Shop all</Link>
        </div>
      </div>
      <div className="market-hero-image">
        {video ? <video controls playsInline preload="none" poster={cover} src={video} className="cms-hero-video" aria-label="Campaign video"/>
          : <Image src={cover || '/editorial/marketplace-edit.webp'} alt={cover ? '' : 'Cream headphones, a cobalt bag and a sculptural lamp on orange studio plinths'}
            fill priority unoptimized={Boolean(cover?.startsWith('https:'))} sizes="(max-width: 700px) 94vw, 56vw" />}
        {!video && !cover && <span className="market-art-caption">THE EVERYDAY UPGRADE</span>}
      </div>
    </section>
  );
}

const shortcuts = [
  { icon: Sparkles, description: 'Pick up where you left off' },
  { icon: Zap, description: 'Browse current sale prices' },
  { icon: Users, description: 'Explore offers with friends' },
  { icon: Ticket, description: 'Find and save offers' },
];

function Discovery({ categories, market }: { categories: Category[]; market: Market }) {
  return <>
    <nav className="market-shortcuts" aria-label="Ways to shop">
      {discoveryLinks.map(({ label, path }, index) => {
        const { icon: Icon, description } = shortcuts[index];
        return <Link key={path} href={marketHref(market, path)}><span className="market-shortcut-icon"><Icon size={20} aria-hidden /></span>
          <span><strong>{label}</strong><small>{description}</small></span><ArrowUpRight className="shortcut-arrow" size={17} aria-hidden /></Link>;
      })}
    </nav>
    <section className="market-category-section" aria-labelledby="shop-categories">
      <div className="market-section-heading">
        <div><p className="eyebrow">FIND YOUR AISLE</p><h2 id="shop-categories">Shop by category</h2></div>
        <Link className="text-link" href={marketHref(market, '/products')}>Shop all <ArrowRight size={15} aria-hidden /></Link>
      </div>
      {categories.length ? <nav className="market-category-tiles" aria-label="Quick browse">
        {categories.map((category) => (
          <Link key={category.id} href={categoryHref(market, category.path)}>
            <span className="market-category-image">
              {category.image ? <Image src={category.image} alt="" fill unoptimized={category.image.startsWith('https://')}
                referrerPolicy="no-referrer" sizes="(max-width: 700px) 40vw, 20vw" /> : <Grid2X2 size={32} aria-hidden />}
            </span>
            <span>{category.label}<ArrowUpRight size={16} aria-hidden /></span>
          </Link>
        ))}
      </nav> : <p className="catalog-notice">Category browsing opens when the catalog is available for this storefront.</p>}
    </section>
  </>;
}

function ProductShelf({ collection, market, products }: {
  collection: { label: string; id: string; href?: string }; market: Market; products: CatalogProduct[];
}) {
  if (!products.length) return null;
  return (
    <section className="home-panel home-product-shelf" aria-label={collection.label}>
      <div className="market-section-heading">
        <div><p className="eyebrow">THE CATALOG EDIT</p><h2>{collection.label}</h2></div>
        <Link className="text-link" href={marketHref(market, collection.href ?? '/collections/' + collection.id)}
          aria-label={'View all ' + collection.label.toLowerCase()}>View all <ArrowRight size={15} aria-hidden /></Link>
      </div>
      <CatalogGrid market={market} products={products} linkVariant={collection.id === 'sale'} />
    </section>
  );
}

export async function Homepage({ market, categories }: { market: Market; categories: Category[] }) {
  const [products, popular, content] = await Promise.all([catalogSample(market), catalogSample(market, true), siteContent()]);
  const homepage = record(content.homepage);
  const positioned = (value: unknown) => contentRows(value).sort((a,b) => Number(a.position) - Number(b.position));
  const curatedCategories = positioned(homepage.shop_by_category).flatMap(row => {
    const category = categories.find(item => item.id === row.category_id);
    const selected = row.subcategory_id ? category?.children.find(item => item.id === row.subcategory_id) : category;
    return selected ? [{ ...selected, label: text(row.label) || selected.label, image: contentMedia(row.icon_image_url) || selected.image }] : [];
  });
  const productById = new Map([...products, ...popular].map(product => [product.id, product]));
  const curated = (ids: unknown[]) => [...new Set(ids)].flatMap(id => productById.get(text(id)) ?? []).slice(0, 5);
  const newest = curated(positioned(homepage.new_arrivals).flatMap(row => rows(row.product_ids)));
  const best = curated(positioned(homepage.best_selling).map(row => row.product_id));
  const featured = curated(contentRows(content.featured_products).flatMap(row => rows(row.products_id)));
  const feature = record(homepage.leather_section);
  const featureImage = contentMedia(feature.banner_image_url);
  const featurePath = contentPath(feature.button_link);
  const desktop = contentRows(content.banners).find(row => contentMedia(row.banner_url));
  const mobile = contentRows(content.mobile_banners).find(row => contentMedia(row.banner_url));
  const bannerProduct = curated(rows((desktop ?? mobile)?.products_id))[0];
  const brands = [...new Map(products.flatMap(({ brand }) => brand ? [[brand.id, brand] as const] : [])).values()].slice(0, 8);
  const sale = products.flatMap((product) => {
    const variants = product.variants.filter((variant) => variant.price?.sale !== undefined);
    return variants.length ? [{ ...product, variants }] : [];
  }).slice(0, 5);
  const selections = [
    newest.length ? newest : [...products].sort((a, b) => compareProducts(a, b, 'newest')).slice(0, 5),
    best.length ? best : popular.filter((product) => inCollection(product, 'best-sellers')).sort((a, b) => compareProducts(a, b, 'popular')).slice(0, 5),
    products.filter((product) => inCollection(product, 'trending')).slice(0, 5),
  ];
  const decorated = new Map((await withAvailability([...new Map(selections.flat().map((product) => [product.id, product])).values()]))
    .map((product) => [product.id, product.availability]));
  const bags = categories.find((category) => category.slug === 'bags');

  return (
    <div className="home container">
        <Hero market={market} content={positioned(content.hero_section)[0] ?? {}} />
        <Discovery market={market} categories={curatedCategories.length ? curatedCategories : categories} />
        {(desktop || mobile) && <section className="cms-banner" aria-label="Featured campaign">
          <picture>
            {mobile && <source media="(max-width: 760px)" srcSet={contentMedia(mobile.banner_url)}/>}
            <img src={contentMedia((desktop ?? mobile)?.banner_url)} alt="GriipBuddy campaign" loading="lazy"/>
          </picture>
          {bannerProduct && <Link className="text-link" href={productHref(market, bannerProduct.slug)}>Shop featured product <ArrowRight size={16} aria-hidden/></Link>}
        </section>}
        <ShoppingHistory market={market} />
        <ProductShelf market={market} collection={{ id: 'sale', label: 'On sale' }} products={sale} />
        <ProductShelf market={market} collection={{ id: 'featured', label: 'Featured finds', href: '/products' }} products={featured} />
        {collections.filter((collection) => collection.id !== 'sale').map((collection, index) => (
          <ProductShelf key={collection.id} market={market} collection={collection}
            products={selections[index].map((product) => ({ ...product, availability: decorated.get(product.id) }))} />
        ))}
        {brands.length > 0 && <section aria-label="Browse brands">
          <div className="market-section-heading"><div><p className="eyebrow">MEET THE MAKERS</p><h2>Browse brands</h2></div></div>
          <div className="brand-strip">{brands.map((brand) => <Link key={brand.id} className="button button-outline"
            href={marketHref(market, '/products?brand=' + encodeURIComponent(brand.id))}>{brand.name} <ArrowUpRight size={15} aria-hidden /></Link>)}</div>
        </section>}
        {(bags || feature.enabled === true) && <section className="campaign" aria-labelledby="campaign-title">
          <div className="campaign-image">
            <Image src={feature.enabled === true && featureImage ? featureImage : '/editorial/campaign.webp'} alt="" fill
              unoptimized={feature.enabled === true && Boolean(featureImage?.startsWith('https:'))}
              sizes="(max-width: 760px) 96vw, 54vw" />
          </div>
          <div className="campaign-copy">
            <p className="eyebrow">The Bag Edit</p>
            <h2 id="campaign-title">{feature.enabled === true ? text(feature.title) : 'Bags for every day.'}</h2>
            {feature.enabled === true && <p>{text(feature.subtitle)}</p>}
            <Link className="text-link" href={feature.enabled === true && featurePath ? marketHref(market, featurePath)
              : bags ? categoryHref(market, bags.path) : marketHref(market, '/products')}>
              {feature.enabled === true ? text(feature.button_text) : 'Shop bags'} <ArrowRight size={16} aria-hidden />
            </Link>
          </div>
        </section>}
    </div>
  );
}
