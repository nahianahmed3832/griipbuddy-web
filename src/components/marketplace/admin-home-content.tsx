import Image from "next/image";
import Link from "next/link";
import { marketStoreHref } from "@/config/regional-path";
import type { Market } from "@/config/markets";
import type { CatalogProduct, Department } from "@/lib/catalog/types";
import { productCards } from "@/lib/catalog/listing";
import { activeOffer, adminLink, adminMedia, ordered, type AdminContent } from "@/lib/marketplace/admin-content";
import { ProductGrid, productHref } from "../product-grid";
import { SaleOfferCountdown } from "./sale-offer-countdown";

export function AdminHomeContent({ data, market, products, departments, regional, showPromotionalMedia }: {
  data: AdminContent;
  market: Market;
  products: readonly CatalogProduct[];
  departments: readonly Department[];
  regional: boolean;
  showPromotionalMedia: boolean;
}) {
  const localHref = (href: string) => marketStoreHref(href, regional ? market.id : undefined);
  const { content, homepage } = data;
  const listings = new Map<string, CatalogProduct>();
  for (const product of products) {
    listings.set(product.id, product);
    listings.set(product.slug, product);
    for (const variant of product.variants) if (variant.sku) listings.set(variant.sku.toLowerCase(), product);
  }
  const listed = (references: { _id?: string; slug?: string; sku?: string }[] = []) => productCards(
    [...new Set(references.flatMap(reference => {
      const product = listings.get(reference._id ?? "") ?? listings.get(`p-${reference._id ?? ""}`) ?? listings.get(reference.slug ?? "") ??
        listings.get(reference.sku?.toLowerCase() ?? "");
      return product ? [product] : [];
    }))],
  );
  const bannerUrl = (items: typeof content) => (items?.banners ?? []).flatMap(banner => {
    const src = adminMedia(banner.banner_url);
    return src ? [{ src, cards: listed(banner.products_id?.map(_id => ({ _id }))) }] : [];
  });
  const desktop = showPromotionalMedia ? bannerUrl(content) : [];
  const mobile = showPromotionalMedia ? bannerUrl({ banners: content?.mobile_banners }) : [];
  const featured = bannerUrl({ banners: content?.featured_products })
    .filter(({ cards }) => showPromotionalMedia || cards.length > 0);
  const slides = showPromotionalMedia ? ordered(content?.hero_section).flatMap(slide => {
    const video = adminMedia(slide.video_url);
    const image = adminMedia(slide.thumbnail_url);
    return video || image ? [{ ...slide, video, image }] : [];
  }) : [];
  const categories = ordered(homepage?.shop_by_category).flatMap(entry => {
    const reference = entry.subcategory_id ?? entry.category_id;
    const department = departments.find(item => item.id === reference?._id || item.slug === reference?.slug);
    const name = entry.label || department?.shortName;
    const image = adminMedia(entry.icon_image_url) ?? department?.image.src;
    return name && image ? [{ name, image, href: department ? "/departments/" + department.slug : "/shop" }] : [];
  });
  const bestSellers = listed(ordered(homepage?.best_selling).map(row => row.product_id));
  const arrivals = ordered(homepage?.new_arrivals).map(group => ({ ...group, cards: listed(group.product_ids) }));
  const leather = homepage?.leather_section?.enabled ? homepage.leather_section : null;
  const leatherImage = showPromotionalMedia ? adminMedia(leather?.banner_image_url) : undefined;
  const leatherCards = listed(leather?.product_ids);
  const campaign = activeOffer(data.offer);
  const offer = campaign?.pageConf?.header;

  return <>
    {slides.map((slide, index) => <section key={slide.position + ":" + slide.title} className="mp-home-section mp-admin-preview">
      {index === 0 ? <h1 className="display-type">{slide.title}</h1> : <h2>{slide.title}</h2>}
      {slide.video ? <video src={slide.video} poster={slide.image} controls preload="metadata" />
        : slide.image && <Image src={slide.image} alt={slide.title} width={1200} height={600} unoptimized />}
      {slide.button?.enabled && slide.button.text && <Link className="button button--primary"
        href={localHref(adminLink(slide.button.redirect_route, "/shop"))}>{slide.button.text}</Link>}
    </section>)}
    {desktop.map(({ src, cards }, index) => <Link key={src} className="mp-home-section mp-admin-preview"
      href={localHref(cards[0] ? productHref(cards[0]) : "/shop")}>
      <picture>
        {mobile[index] && <source media="(max-width: 680px)" srcSet={mobile[index].src} />}
        <Image src={src} alt="Store banner" width={1200} height={600} unoptimized />
      </picture>
    </Link>)}
    {mobile.slice(desktop.length).map(({ src, cards }) => <Link key={src} className="mp-home-section mp-admin-preview mp-admin-mobile"
      href={localHref(cards[0] ? productHref(cards[0]) : "/shop")}>
      <Image src={src} alt="Store banner" width={750} height={450} unoptimized />
    </Link>)}
    {featured.map(({ src, cards }) => <section key={src}
      className={showPromotionalMedia ? "mp-home-section mp-admin-preview" : "mp-home-section"}>
      {showPromotionalMedia && <Image src={src} alt="Featured products" width={1200} height={600} unoptimized />}
      {cards.length > 0 && <ProductGrid cards={cards} market={market} regional={regional} />}
    </section>)}
    {offer && <section className="mp-home-section mp-cms-offer">
      <div className="mp-section-heading"><h2>{offer.title_1} {offer.title_2}</h2>
        <Link href={localHref("/shop?offer=sale")}>{offer.button_label}</Link>
      </div>
      <p>{offer.description}</p>
      <SaleOfferCountdown campaign={campaign} market={market} />
    </section>}
    {categories.length > 0 && <section className="mp-home-section">
      <div className="mp-section-heading"><h2>Shop by category</h2></div>
      <ul className="mp-category-grid">{categories.map(({ name, image, href }) => <li key={name + href}>
        <Link href={localHref(href)}>
          <span className="mp-category-photo"><Image src={image} alt="" fill unoptimized /></span>{name}
        </Link>
      </li>)}</ul>
    </section>}
    {bestSellers.length > 0 && <section className="mp-home-section">
      <div className="mp-section-heading"><h2>Best selling</h2></div>
      <ProductGrid cards={bestSellers} market={market} regional={regional} />
    </section>}
    {arrivals.map(group => <section key={group.slug} className="mp-home-section">
      <div className="mp-section-heading"><h2>{group.name}</h2></div>
      {group.cards.length > 0 && <ProductGrid cards={group.cards} market={market} regional={regional} />}
    </section>)}
    {leather && <section className={showPromotionalMedia ? "mp-home-section mp-admin-preview" : "mp-home-section"}>
      <div className="mp-section-heading"><h2>{leather.title}</h2>
        {leather.button_text && <Link href={localHref(adminLink(leather.button_link, "/shop"))}>{leather.button_text}</Link>}
      </div>
      {leather.subtitle && <p>{leather.subtitle}</p>}
      {leatherImage && <Image src={leatherImage} alt="" width={1200} height={600} unoptimized />}
      {leatherCards.length > 0 && <ProductGrid cards={leatherCards} market={market} regional={regional} />}
    </section>}
  </>;
}
