import Link from "next/link";
import { ArrowRight, Smartphone } from "lucide-react";
import { marketStoreHref } from "@/config/regional-path";
import { hybridDemoMode } from "@/lib/release-config";
import { formatMoney, type Market } from "@/config/markets";
import type { CatalogImage, CatalogProduct, Department } from "@/lib/catalog/types";
import { discountPercentage, newestFirst, productCards } from "@/lib/catalog/listing";
import { catalogDevices } from "@/lib/catalog/devices";
import { departmentFamily, stockedDepartments } from "@/lib/catalog/departments";
import { cardActivity } from "@/lib/catalog/card-activity";
import { ProductGrid, productHref } from "../product-grid";
import { CatalogPhoto } from "../catalog-photo";
import { RecentlyViewed } from "./recent";
import { ProductRail } from "./product-rail";
import { SaleCountdown } from "./sale-countdown";
import { adminMedia, readAdminContent } from "@/lib/marketplace/admin-content";
import { AdminHomeContent } from "./admin-home-content";
import styles from "./product-rail.module.css";

function TileImage({ image, sizes, responsive, priority = false }: { image: CatalogImage; sizes: string; responsive: boolean; priority?: boolean }) {
  return <CatalogPhoto image={image} fill responsive={responsive} rendition={priority ? "detail" : "card"}
    sizes={sizes} loading={priority ? "eager" : "lazy"} fetchPriority={priority ? "high" : undefined} />;
}

export async function MarketplaceHome({ market, departments, products }: { market: Market; departments: readonly Department[]; products: readonly CatalogProduct[] }) {
  const regional = hybridDemoMode();
  const region = regional ? market.id : undefined;
  const href = (path: string) => marketStoreHref(path, region);
  const adminContent = market.id === "bd" ? await readAdminContent() : null;
  const customHero = adminContent?.content?.hero_section?.some(slide =>
    adminMedia(slide.video_url) || adminMedia(slide.thumbnail_url));
  const models = catalogDevices(products);
  const availableDepartments = stockedDepartments(departments, products.map(product => product.departmentId));
  const roots = availableDepartments.filter(department => !department.parentId);
  const categories = roots.length === 1 && availableDepartments.length > 1
    ? availableDepartments.filter(department => department.parentId === roots[0].id)
    : roots;
  const departmentTiles = categories.map(department => {
    const family = departmentFamily(availableDepartments, department.id);
    const items = products.filter(item => family.has(item.departmentId));
    const cards = productCards(items);
    const photo = cards.find(card => card.inStock)?.image ?? cards[0]?.image ?? department.image;
    return { id: department.id, href: `/departments/${department.slug}`, name: department.shortName, photo };
  });
  const cards = productCards(products);
  const available = cards.filter(card => card.inStock);
  const newItems = productCards([...products].sort(newestFirst)).filter(card => card.inStock).slice(0, 6);
  const heroPhoto = departmentTiles[0]?.photo ?? { src: "/editorial/hero.webp", alt: "GriipBuddy accessories" };
  const side = departmentTiles.find(tile => /combo/.test(tile.href)) ?? departmentTiles[2] ?? departmentTiles[1];
  const last = available.find(card => card.image.src !== heroPhoto.src) ?? available[0];
  const deals = available.filter(card => discountPercentage(card) > 0)
    .sort((first, second) => discountPercentage(second) - discountPercentage(first)).slice(0, 6);
  const topDeal = deals[0];
  const bangladeshDesktop = regional && market.id === "bd";
  const saleBeforeCms = Boolean(bangladeshDesktop && customHero && topDeal);
  const cms = adminContent && (
    <AdminHomeContent data={adminContent} market={market} departments={departments} products={products}
      regional={regional} saleBeforeCms={saleBeforeCms} />
  );
  const end = topDeal?.promotion?.endsAt;
  const remaining = topDeal?.promotion?.remainingSeconds ?? 0;
  const timed = end && remaining > 0 && remaining <= 30 * 24 * 60 * 60;
  const activity = await cardActivity(market.id, [...newItems, ...deals].map(item => item.id));
  const budgets = market.id === "bd" ? [500, 1000] : [20, 50];
  const chips = [
    ...budgets.map((budget, index) => ({ name: `Gifts under ${formatMoney(budget * 100, market)}`, href: `/shop?max=${budget}&availability=in-stock`,
      photo: available.find(card => card.priceMinor <= budget * 100 && card.priceMinor > (budgets[index - 1] ?? 0) * 100)?.image ?? heroPhoto })),
    ...departmentTiles.slice(1, 4),
  ];
  return <>
    <div className={saleBeforeCms ? "shell mp-home mp-home--desktop-sale" : "shell mp-home"}>
      {!saleBeforeCms && cms}
      {(!customHero || saleBeforeCms) && (topDeal ? <section
        className={saleBeforeCms ? "mp-sale-banner mp-sale-banner--desktop-only" : "mp-sale-banner"}
        data-market={market.id} data-classic-desktop={bangladeshDesktop || undefined} aria-labelledby="mp-sale-heading">
        <div className="mp-sale-message">
          <p>{market.id === "bd" ? "Bangladesh sale" : "US sale"}</p>
          <h1 id="mp-sale-heading">Up to {discountPercentage(topDeal)}% off</h1>
          <div className="mp-sale-terms">
            {timed ? <>
              <SaleCountdown key={end} endsAt={end} initialSeconds={remaining}/>
              <span className="sr-only">Featured offer ends <time dateTime={end}>{new Date(end).toLocaleString(market.locale, { timeZone: market.id === "bd" ? "Asia/Dhaka" : "America/New_York", dateStyle: "medium", timeStyle: "short" })}</time>.</span>
            </> : "Selected styles"}
          </div>
          <Link className="mp-sale-cta" href={href("/shop?offer=sale")}>Shop sale <ArrowRight size={17} aria-hidden="true"/></Link>
        </div>
        <div className="mp-sale-products">
          {deals.slice(0, 2).map(card => <Link key={card.id} href={productHref(card, region)} className="mp-sale-product">
            <span className="mp-sale-photo"><TileImage image={card.image} responsive={regional}
              sizes="(max-width: 730px) 40vw, 22vw" priority={!saleBeforeCms && card.id === topDeal.id}/></span>
            <span className="mp-sale-price"><strong>{formatMoney(card.priceMinor, market)}</strong> <del>{formatMoney(card.regularMinor!, market)}</del></span>
            <span className="sr-only">{card.name}</span>
          </Link>)}
        </div>
      </section> : <section className="mp-hero" aria-label="Featured shopping">
        <div className="mp-hero-feature">
          <div className="mp-hero-copy">
            <h1 className="display-type">{market.id === "bd" && departmentTiles[0]?.name === "Phone Cases" ? "Find your next phone case" : "Shop the latest arrivals"}</h1>
            <p>Available in {market.name}</p>
            <Link className="button button--primary" href={href(departmentTiles[0]?.href ?? "/shop")}>Discover more</Link>
          </div>
          <Link className="mp-hero-photo" href={href(departmentTiles[0]?.href ?? "/shop")} aria-label={departmentTiles[0]?.name ?? "Shop all"}>
            <TileImage image={heroPhoto} responsive={regional} sizes="(max-width: 680px) 55vw, 34vw" priority/>
          </Link>
        </div>
        <Link className="mp-hero-side" href={href(side?.href ?? (last ? productHref(last) : "/shop"))}>
          <TileImage image={side?.photo ?? last?.image ?? heroPhoto} responsive={regional} sizes="(max-width: 680px) 93vw, 33vw"/>
          <span><strong>{side?.name ?? "New arrivals"}</strong><small>Shop now</small></span>
        </Link>
      </section>)}
      {deals.length > 0 && <section className="mp-home-section mp-deals-section" aria-labelledby="mp-deal-heading">
        <div className="mp-section-heading"><h2 id="mp-deal-heading">Super deals</h2><Link href={href("/shop?offer=sale")}>See all deals <ArrowRight size={17} aria-hidden="true"/></Link></div>
        {deals.length > 4 ? <ProductRail><ProductGrid cards={deals} market={market} regional={regional} activity={activity}/></ProductRail>
          : <ProductGrid cards={deals} market={market} regional={regional} activity={activity}/>}
      </section>}
      {saleBeforeCms && <div className="mp-home-cms">{cms}</div>}
      <RecentlyViewed market={market} regional={regional}/>
      {models.length > 0 && <section className="mp-home-section" aria-labelledby="mp-models-heading">
        <div className="mp-section-heading"><h2 id="mp-models-heading">Shop by phone model</h2><Link href={href("/shop")}>Browse all <ArrowRight size={17} aria-hidden="true"/></Link></div>
        <ul className={styles.deviceLinks}>{models.slice(0, 10).map(model => <li key={model.id}>
          <Link href={href(`/shop?device=${model.id}`)}><Smartphone size={15} aria-hidden="true"/>{model.name}</Link>
        </li>)}</ul>
      </section>}
      <section className="mp-home-section" aria-labelledby="mp-gift-heading">
        <div className="mp-section-heading"><h2 id="mp-gift-heading">Find a gift for any occasion</h2><Link href={href("/gifts")}>Explore gifts <ArrowRight size={17}/></Link></div>
        <ul className="mp-gift-chips">{chips.map(item => <li key={item.href}><Link href={href(item.href)}>
          <span><TileImage image={item.photo} responsive={regional} sizes="92px"/></span>{item.name}
        </Link></li>)}</ul>
      </section>
      {!adminContent?.homepage?.shop_by_category?.length && <section className="mp-home-section" aria-labelledby="mp-popular-heading">
        <div className="mp-section-heading"><h2 id="mp-popular-heading">Shop by category</h2></div>
        <ul className="mp-category-grid">{[...departmentTiles, { id: "all", href: "/shop", name: "Shop all", photo: last?.image ?? heroPhoto }].map(item =>
          <li key={item.id}><Link href={href(item.href)}><span className="mp-category-photo"><TileImage image={item.photo} responsive={regional} sizes="(max-width: 680px) 30vw, 17vw"/></span>{item.name}</Link></li>)}</ul>
      </section>}
      {newItems.length > 0 && !adminContent?.homepage?.new_arrivals?.length && <section className="mp-home-section" aria-labelledby="mp-new-heading">
        <div className="mp-editorial-heading"><h2 id="mp-new-heading">New arrivals</h2><Link className="button button--outline" href={href("/shop?sort=newest")}>Shop new arrivals</Link></div>
        {newItems.length > 4 ? <ProductRail><ProductGrid cards={newItems} market={market} regional={regional} activity={activity}/></ProductRail>
          : <ProductGrid cards={newItems} market={market} regional={regional} activity={activity}/>}
      </section>}
    </div>
  </>;
}
