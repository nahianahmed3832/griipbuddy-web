import Image from "next/image";
import type { Metadata } from "next";
import Link from "next/link";
import { ProductGrid, productHref } from "@/components/product-grid";
import { SectionHeading } from "@/components/store-ui";
import { formatMoney } from "@/config/markets";
import { heroPhoto } from "@/lib/catalog/imagery";
import { newestFirst, productCards } from "@/lib/catalog/listing";
import { catalog } from "@/lib/catalog/repository";
import { currentMarket } from "@/lib/market-server";
import { storefrontPath } from "@/config/storefront-path";
import { canonicalUrl, marketplaceMode, productionMode } from "@/lib/release-config";
import { MarketplaceHome } from "@/components/marketplace/home";

const heroProductIds = ["p-tote", "p-notebooks"];

export function generateMetadata(): Metadata {
  const canonical = canonicalUrl("/");
  return canonical ? { alternates: { canonical } } : {};
}

export default async function Home() {
  const production = productionMode();
  const market = await currentMarket();
  if (marketplaceMode()) {
    const [departments, products] = await Promise.all([catalog.listDepartments(), catalog.listProducts({ marketId: market.id, leadImageOnly: true })]);
    return <MarketplaceHome market={market} departments={departments} products={products}/>;
  }
  const [departments, collections, products] = await Promise.all([
    catalog.listDepartments(), catalog.listCollections(), catalog.listProducts({ marketId: market.id, leadImageOnly: true }),
  ]);
  const curated = collections.filter((collection) => collection.image);
  const heroPicks = productCards(production ? products : products.filter((product) => heroProductIds.includes(product.id))).slice(0, 2);
  const hero = production ? heroPicks[0]?.image : heroPhoto;
  const carry = collections.find(({ slug }) => slug === "everyday-carry");
  const newCollection = collections.find(({ slug }) => slug === "new-arrivals");
  const featuredCollection = collections.find(({ slug }) => slug === "featured");
  const newArrivals = productCards(products.filter((product) => product.newArrival).sort(newestFirst)).slice(0, 4);
  const featured = productCards(products.filter((product) => product.featured)).slice(0, 4);

  return (
    <div className="shell home">
      <section className={hero ? "hero" : "hero hero--empty"} aria-labelledby="hero-heading">
        {hero && <div className="hero__visual">
          <Image src={storefrontPath(hero.src)} alt={hero.alt} fill preload sizes="(max-width: 700px) 100vw, (max-width: 1500px) 64vw, 910px" />
        </div>}
        <div className="hero__aside">
          {heroPicks.length > 0 && <ul className="hero__products" aria-label="Featured products">
            {heroPicks.map((card) => (
              <li key={card.id}>
                <Link href={productHref(card)} aria-label={`${card.name}, ${card.multiplePrices ? "from " : ""}${formatMoney(card.priceMinor, market)}`}>
                  <Image src={storefrontPath(card.image.src)} alt={card.image.alt} fill sizes="(max-width: 700px) 24vw, 210px" />
                  <span>{card.multiplePrices && "From "}{formatMoney(card.priceMinor, market)}</span>
                </Link>
              </li>
            ))}
          </ul>}
          <div className="hero__copy">
            <h1 id="hero-heading" className="display-type">Essentials for every day</h1>
            <Link className="button button--primary hero__cta" href={carry ? "/collections/everyday-carry" : "/shop"}>{carry ? "Shop Everyday Carry" : "Shop all"}</Link>
          </div>
        </div>
      </section>

      {departments.length > 0 && <section className="home-section" aria-labelledby="department-heading">
        <SectionHeading id="department-heading" title="Shop by department" action={{ href: "/shop", label: "Shop all" }} />
        <ul className="department-grid">
          {departments.map((department) => (
            <li key={department.id}>
              <Link className="department-card" href={`/departments/${department.slug}`}>
                <span className="department-card__visual">
                  <Image src={storefrontPath(department.image.src)} alt={department.image.alt} fill sizes="(max-width: 550px) 28vw, 120px" />
                </span>
                <span className="department-card__name">{department.shortName}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>}

      {curated.length > 0 && <section className="home-section" aria-labelledby="collection-heading">
        <SectionHeading id="collection-heading" title="Curated collections" />
        <ul className="collection-grid">
          {curated.map((collection) => collection.image && (
            <li key={collection.id}>
              <Link href={`/collections/${collection.slug}`} className="collection-card">
                <span className="collection-card__visual">
                  <Image src={storefrontPath(collection.image.src)} alt={collection.image.alt} fill sizes="(max-width: 700px) 32vw, 450px" />
                </span>
                <span className="collection-card__name">{collection.name}</span>
              </Link>
            </li>
          ))}
        </ul>
      </section>}

      {(!production || newArrivals.length > 0) && <section className="home-section" aria-labelledby="new-heading">
        <SectionHeading id="new-heading" title="New arrivals" action={{ href: newCollection ? "/collections/new-arrivals" : "/shop", label: "View all" }} />
        <ProductGrid cards={newArrivals} market={market} />
      </section>}

      {(!production || featured.length > 0) && <section className="home-section" aria-labelledby="featured-heading">
        <SectionHeading id="featured-heading" title="Featured picks" action={{ href: featuredCollection ? "/collections/featured" : "/shop", label: "View all" }} />
        <ProductGrid cards={featured} market={market} />
      </section>}
    </div>
  );
}
