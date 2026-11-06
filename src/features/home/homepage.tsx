import { ArrowRight, ArrowUpRight, Grid2X2 } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { compareProducts, inCollection } from '@/features/catalog/browse';
import { categoryHref, collections, marketHref, productHref, type CatalogProduct, type Category, type Market } from '@/features/catalog/catalog';
import { catalogProducts, withAvailability } from '@/features/catalog/data';
import { CatalogGrid } from '@/features/catalog/listing';
import { record, rows } from '@/features/catalog/api';
import { contentMedia, contentPath, contentRows, siteContent, text } from './content';

function Hero({ market, content }: { market: Market; content: Record<string, unknown> }) {
  const button = record(content.button);
  const video = contentMedia(content.video_url);
  const cover = contentMedia(content.thumbnail_url);
  const destination = contentPath(button.redirect_route);
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-image">
        {video ? <video controls playsInline preload="none" poster={cover} src={video} className="cms-hero-video" aria-label="Campaign video"/>
          : <Image src={cover || '/editorial/everyday-edit.webp'} alt={cover ? '' : 'Woman carrying a cobalt crossbody bag against a sunlit stone wall'}
            fill priority unoptimized={Boolean(cover?.startsWith('https:'))} sizes="(max-width: 760px) 100vw, 60vw" />}
      </div>
      <div className="container hero-inner">
        <div className="hero-copy">
          <p className="eyebrow">The Everyday Edit</p>
          <h1 id="hero-title">{text(content.title) || 'Grip your day.'}</h1>
          <p>Distinctive cases, bags and accessories for the things you carry every day.</p>
          <Link className="button button-primary" href={marketHref(market, button.enabled === true && destination ? destination : '/collections/new-arrivals')}>
            {button.enabled === true && destination ? text(button.text) : 'Shop new arrivals'} <ArrowRight size={16} aria-hidden />
          </Link>
        </div>
      </div>
    </section>
  );
}

function Discovery({ categories, market }: { categories: Category[]; market: Market }) {
  return (
    <div className="home-discovery">
      <section className="home-panel" aria-labelledby="shop-categories">
        <div className="home-panel-heading">
          <h2 id="shop-categories">Shop by category</h2>
          <Link className="text-link" href={marketHref(market, '/products')}>Shop all <ArrowRight size={14} aria-hidden /></Link>
        </div>
        <nav className="home-category-tiles" aria-label="Quick browse">
          {categories.map((category) => (
            <Link key={category.id} href={categoryHref(market, category.path)}>
              <span className="home-category-image">
                {category.image ? <Image src={category.image} alt="" fill unoptimized={category.image.startsWith('https://')}
                  referrerPolicy="no-referrer" sizes="68px" /> : <Grid2X2 size={22} aria-hidden />}
              </span>
              <span>{category.label}</span>
            </Link>
          ))}
        </nav>
      </section>
      <section className="home-panel home-collections" aria-labelledby="shop-collections">
        <div className="home-panel-heading"><h2 id="shop-collections">Explore collections</h2></div>
        {collections.map((collection) => (
          <Link key={collection.id} href={marketHref(market, '/collections/' + collection.id)}>
            <span>{collection.label}</span><ArrowUpRight size={16} aria-hidden />
          </Link>
        ))}
      </section>
    </div>
  );
}

function ProductShelf({ collection, market, products }: {
  collection: typeof collections[number]; market: Market; products: CatalogProduct[];
}) {
  if (!products.length) return null;
  return (
    <section className="home-panel home-product-shelf" aria-label={collection.label}>
      <div className="home-panel-heading">
        <h2>{collection.label}</h2>
        <Link className="text-link" href={marketHref(market, '/collections/' + collection.id)}
          aria-label={'View all ' + collection.label.toLowerCase()}>View all <ArrowRight size={15} aria-hidden /></Link>
      </div>
      <CatalogGrid market={market} products={products} />
    </section>
  );
}

export async function Homepage({ market, categories }: { market: Market; categories: Category[] }) {
  const [products, popular, content] = await Promise.all([catalogProducts(market), catalogProducts(market, true), siteContent()]);
  const homepage = record(content.homepage);
  const positioned = (value: unknown) => contentRows(value).sort((a,b) => Number(a.position) - Number(b.position));
  const curatedCategories = positioned(homepage.shop_by_category).flatMap(row => {
    const category = categories.find(item => item.id === row.category_id);
    const selected = row.subcategory_id ? category?.children.find(item => item.id === row.subcategory_id) : category;
    return selected ? [{ ...selected, label: text(row.label) || selected.label, image: contentMedia(row.icon_image_url) || selected.image }] : [];
  });
  const productById = new Map(products.map(product => [product.id, product]));
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
  const selections = [
    newest.length ? newest : [...products].sort((a, b) => compareProducts(a, b, 'newest')).slice(0, 5),
    best.length ? best : popular.filter((product) => inCollection(product, 'best-sellers')).sort((a, b) => compareProducts(a, b, 'popular')).slice(0, 5),
    featured.length ? featured : products.filter((product) => inCollection(product, 'trending')).slice(0, 5),
  ];
  const decorated = new Map((await withAvailability([...new Map(selections.flat().map((product) => [product.id, product])).values()]))
    .map((product) => [product.id, product.availability]));
  const bags = categories.find((category) => category.slug === 'bags');

  return (
    <>
      <Hero market={market} content={positioned(content.hero_section)[0] ?? {}} />
      <div className="home container">
        {(desktop || mobile) && <section className="cms-banner" aria-label="Featured campaign">
          <picture>
            {mobile && <source media="(max-width: 760px)" srcSet={contentMedia(mobile.banner_url)}/>}
            <img src={contentMedia((desktop ?? mobile)?.banner_url)} alt="GriipBuddy campaign" loading="lazy"/>
          </picture>
          {bannerProduct && <Link className="text-link" href={productHref(market, bannerProduct.slug)}>Shop featured product <ArrowRight size={16} aria-hidden/></Link>}
        </section>}
        <Discovery market={market} categories={curatedCategories.length ? curatedCategories : categories} />
        {collections.map((collection, index) => (
          <ProductShelf key={collection.id} market={market} collection={collection}
            products={selections[index].map((product) => ({ ...product, availability: decorated.get(product.id) }))} />
        ))}
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
    </>
  );
}
