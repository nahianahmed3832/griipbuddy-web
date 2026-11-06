import { ArrowRight, ArrowUpRight, Grid2X2 } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { compareProducts, inCollection } from '@/features/catalog/browse';
import { categoryHref, collections, marketHref, type CatalogProduct, type Category, type Market } from '@/features/catalog/catalog';
import { catalogProducts, withAvailability } from '@/features/catalog/data';
import { CatalogGrid } from '@/features/catalog/listing';

function Hero({ market }: { market: Market }) {
  return (
    <section className="hero" aria-labelledby="hero-title">
      <div className="hero-image">
        <Image src="/editorial/everyday-edit.webp" alt="Woman carrying a cobalt crossbody bag against a sunlit stone wall"
          fill priority sizes="(max-width: 760px) 100vw, 60vw" />
      </div>
      <div className="container hero-inner">
        <div className="hero-copy">
          <p className="eyebrow">The Everyday Edit</p>
          <h1 id="hero-title">Grip your day.</h1>
          <p>Distinctive cases, bags and accessories for the things you carry every day.</p>
          <Link className="button button-primary" href={marketHref(market, '/collections/new-arrivals')}>
            Shop new arrivals <ArrowRight size={16} aria-hidden />
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
  const [products, popular] = await Promise.all([catalogProducts(market), catalogProducts(market, true)]);
  const selections = [
    [...products].sort((a, b) => compareProducts(a, b, 'newest')).slice(0, 5),
    popular.filter((product) => inCollection(product, 'best-sellers')).sort((a, b) => compareProducts(a, b, 'popular')).slice(0, 5),
    products.filter((product) => inCollection(product, 'trending')).slice(0, 5),
  ];
  const decorated = new Map((await withAvailability([...new Map(selections.flat().map((product) => [product.id, product])).values()]))
    .map((product) => [product.id, product.availability]));
  const bags = categories.find((category) => category.slug === 'bags');

  return (
    <>
      <Hero market={market} />
      <div className="home container">
        <Discovery market={market} categories={categories} />
        {collections.map((collection, index) => (
          <ProductShelf key={collection.id} market={market} collection={collection}
            products={selections[index].map((product) => ({ ...product, availability: decorated.get(product.id) }))} />
        ))}
        {bags && <section className="campaign" aria-labelledby="campaign-title">
          <div className="campaign-image">
            <Image src="/editorial/campaign.webp" alt="Person carrying a blue bag down sunlit stone steps" fill
              sizes="(max-width: 760px) 96vw, 54vw" />
          </div>
          <div className="campaign-copy">
            <p className="eyebrow">The Bag Edit</p>
            <h2 id="campaign-title">Bags for every day.</h2>
            <Link className="text-link" href={categoryHref(market, bags.path)}>Shop bags <ArrowRight size={16} aria-hidden /></Link>
          </div>
        </section>}
      </div>
    </>
  );
}
